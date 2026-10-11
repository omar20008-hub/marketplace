import "server-only";
import { prisma } from "@/lib/db";
import { newOAuthState, OAUTH_STATE_TTL_SECONDS } from "@/lib/oauth-state";
import { publicOrigin } from "@/lib/public-origin";
import { openCredential, sealCredential } from "@/lib/secrets";
import type { ConnectorProvider } from "./providers";

/**
 * Signing a person into an outside tool, and keeping the connection it returns.
 *
 * The state rides in a signed cookie scoped to this one provider (see
 * oauth-state.ts), so a half-finished sign-in for one tool cannot be completed
 * through another, and nothing about it reaches the database until Google-style
 * checks pass: the nonce matches, the cookie was issued to this user, and the
 * tool itself confirms who the person is.
 */

export class ConnectorSignInError extends Error {
  constructor(readonly code: "tool_token" | "tool_identity") {
    super(code);
    this.name = "ConnectorSignInError";
  }
}

export const connectorCookieName = (provider: ConnectorProvider) => `c_oauth_${provider.id}`;
export const connectorCookiePath = (provider: ConnectorProvider) => `/api/connectors/${provider.id}`;

export function callbackUrl(provider: ConnectorProvider, request: Request): string {
  return `${publicOrigin(request)}/api/connectors/${provider.id}/callback`;
}

export function beginSignIn(
  provider: ConnectorProvider,
  input: { userId: string; returnTo: string; request: Request },
) {
  const { nonce, cookie } = newOAuthState({ userId: input.userId, verifier: "", returnTo: input.returnTo });
  const url = new URL(provider.authorizeUrl);
  const params: Record<string, string> = {
    client_id: provider.clientId(),
    redirect_uri: callbackUrl(provider, input.request),
    response_type: "code",
    state: nonce,
  };
  if (provider.scopes.length > 0) params.scope = provider.scopes.join(" ");
  url.search = new URLSearchParams(params).toString();
  return { url: url.toString(), cookie, cookieMaxAge: OAUTH_STATE_TTL_SECONDS };
}

type TokenAnswer = { access_token: string; refresh_token?: string; expires_in?: number };

async function exchangeCode(
  provider: ConnectorProvider,
  code: string,
  redirectUri: string,
): Promise<TokenAnswer> {
  const response = await fetch(provider.tokenUrl, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      client_id: provider.clientId(),
      client_secret: provider.clientSecret(),
      redirect_uri: redirectUri,
      code,
    }),
    cache: "no-store",
  });
  const json = (await response.json().catch(() => null)) as Partial<TokenAnswer> | null;
  if (!response.ok || !json?.access_token) throw new ConnectorSignInError("tool_token");
  return { ...json, access_token: json.access_token };
}

async function readIdentity(provider: ConnectorProvider, accessToken: string) {
  const response = await fetch(provider.identityUrl, {
    headers: { authorization: `Bearer ${accessToken}` },
    cache: "no-store",
  });
  const identity = response.ok
    ? provider.accountFrom(await response.json().catch(() => null))
    : null;
  if (!identity) throw new ConnectorSignInError("tool_identity");
  return identity;
}

/** Completes a sign-in whose state has already been checked. Returns the connection's id. */
export async function completeSignIn(
  provider: ConnectorProvider,
  input: { userId: string; code: string; request: Request },
): Promise<string> {
  const tokens = await exchangeCode(provider, input.code, callbackUrl(provider, input.request));
  const identity = await readIdentity(provider, tokens.access_token);

  const existing = await prisma.connector.findUnique({
    where: {
      userId_credentialType_accountRef: {
        userId: input.userId,
        credentialType: provider.credentialType,
        accountRef: identity.accountRef,
      },
    },
  });
  // Tools that issue a refresh token only on first consent keep the one they
  // already gave, rather than losing the ability to renew the connection.
  const refreshToken =
    tokens.refresh_token ??
    (existing?.secretJson ? openCredential(existing.secretJson).refresh_token : undefined);

  const secret: Record<string, string> = { access_token: tokens.access_token };
  if (refreshToken) secret.refresh_token = refreshToken;

  const expiresAt = tokens.expires_in ? new Date(Date.now() + tokens.expires_in * 1000) : null;
  const connector = await prisma.connector.upsert({
    where: {
      userId_credentialType_accountRef: {
        userId: input.userId,
        credentialType: provider.credentialType,
        accountRef: identity.accountRef,
      },
    },
    create: {
      userId: input.userId,
      credentialType: provider.credentialType,
      displayName: identity.label,
      initials: provider.initials,
      accountRef: identity.accountRef,
      status: "ACTIVE",
      reusable: true,
      secretJson: sealCredential(secret),
      expiresAt,
    },
    update: { status: "ACTIVE", displayName: identity.label, secretJson: sealCredential(secret), expiresAt },
  });
  return connector.id;
}
