import "server-only";
import { createHash, randomBytes } from "node:crypto";
import { prisma } from "@/lib/db";
import { newOAuthState, OAUTH_STATE_TTL_SECONDS } from "@/lib/oauth-state";
import { publicOrigin } from "@/lib/public-origin";
import { openCredential, sealCredential } from "@/lib/secrets";
import type { ConnectorProvider } from "./providers";
import { postToTokenEndpoint } from "./token-request";
import { accessToken as oauth1AccessToken, approvalUrl, identityRequestUrl, requestToken } from "./oauth1";

/**
 * Signing a person into an outside tool, and keeping the connection it returns.
 *
 * The state rides in a signed cookie scoped to this one provider (see
 * oauth-state.ts), so a half-finished sign-in for one tool cannot be completed
 * through another, and nothing about it reaches the database until the checks
 * pass: the nonce matches, the cookie was issued to this user, and the tool
 * itself confirms who the person is.
 *
 * Two protocols. OAuth 2 (most tools), with PKCE where a provider asks for it.
 * OAuth 1.0a (Trello), whose request token secret is kept in the same cookie
 * between the two steps.
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

/** The PKCE verifier and its S256 challenge. */
function pkcePair() {
  const verifier = randomBytes(32).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  return { verifier, challenge };
}

/**
 * The first step: where to send the person, and the cookie that must come back
 * with them. Async because OAuth 1.0a asks the tool for a request token first.
 */
export async function beginSignIn(
  provider: ConnectorProvider,
  input: { userId: string; returnTo: string; request: Request },
): Promise<{ url: string; cookie: string; cookieMaxAge: number }> {
  if (provider.oauth1) {
    // The callback carries the nonce, so the tool sends it back with the request token.
    const { nonce } = newOAuthState({ userId: input.userId, verifier: "", returnTo: input.returnTo });
    const token = await requestToken(provider, `${callbackUrl(provider, input.request)}?state=${nonce}`);
    if (!token) throw new ConnectorSignInError("tool_token");
    const { cookie } = newOAuthState({
      userId: input.userId,
      verifier: JSON.stringify(token),
      returnTo: input.returnTo,
      nonce,
    });
    return { url: approvalUrl(provider, token.token), cookie, cookieMaxAge: OAUTH_STATE_TTL_SECONDS };
  }

  const pkce = provider.pkce ? pkcePair() : null;
  const { nonce, cookie } = newOAuthState({
    userId: input.userId,
    verifier: pkce?.verifier ?? "",
    returnTo: input.returnTo,
  });
  const url = new URL(provider.authorizeUrl);
  url.searchParams.set("client_id", provider.clientId());
  url.searchParams.set("redirect_uri", callbackUrl(provider, input.request));
  url.searchParams.set("response_type", "code");
  url.searchParams.set("state", nonce);
  if (provider.scopes.length > 0) url.searchParams.set("scope", provider.scopes.join(" "));
  if (pkce) {
    url.searchParams.set("code_challenge", pkce.challenge);
    url.searchParams.set("code_challenge_method", "S256");
  }
  return { url: url.toString(), cookie, cookieMaxAge: OAUTH_STATE_TTL_SECONDS };
}

type TokenAnswer = { access_token: string; refresh_token?: string; expires_in?: number };

async function exchangeCode(
  provider: ConnectorProvider,
  code: string,
  redirectUri: string,
  verifier: string,
): Promise<TokenAnswer> {
  const params: Record<string, string> = {
    grant_type: "authorization_code",
    redirect_uri: redirectUri,
    code,
  };
  if (provider.pkce) params.code_verifier = verifier;

  const response = await postToTokenEndpoint(provider, params);
  const json = (await response.json().catch(() => null)) as Partial<TokenAnswer> | null;
  if (!response.ok || !json?.access_token) throw new ConnectorSignInError("tool_token");
  return { ...json, access_token: json.access_token };
}

type Identity = { accountRef: string; label: string };

async function readIdentity(provider: ConnectorProvider, accessToken: string): Promise<Identity> {
  if (!provider.identityUrl) throw new ConnectorSignInError("tool_identity");
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

/** Stores the connection, or refreshes the one the same account already has. Returns its id. */
async function saveConnection(
  provider: ConnectorProvider,
  userId: string,
  identity: Identity,
  tokens: { secret: Record<string, string>; expiresAt: Date | null },
): Promise<string> {
  const existing = await prisma.connector.findUnique({
    where: {
      userId_credentialType_accountRef: {
        userId,
        credentialType: provider.credentialType,
        accountRef: identity.accountRef,
      },
    },
  });
  // Tools that issue a refresh token only on first consent keep the one they
  // already gave, rather than losing the ability to renew the connection.
  const secret = { ...tokens.secret };
  if (!secret.refresh_token && existing?.secretJson) {
    const previous = openCredential(existing.secretJson).refresh_token;
    if (previous) secret.refresh_token = previous;
  }

  const connector = await prisma.connector.upsert({
    where: {
      userId_credentialType_accountRef: {
        userId,
        credentialType: provider.credentialType,
        accountRef: identity.accountRef,
      },
    },
    create: {
      userId,
      credentialType: provider.credentialType,
      displayName: identity.label,
      initials: provider.initials,
      accountRef: identity.accountRef,
      status: "ACTIVE",
      reusable: true,
      secretJson: sealCredential(secret),
      expiresAt: tokens.expiresAt,
    },
    update: {
      status: "ACTIVE",
      displayName: identity.label,
      secretJson: sealCredential(secret),
      expiresAt: tokens.expiresAt,
    },
  });
  return connector.id;
}

/** Completes a sign-in whose state has already been checked. Returns the connection's id. */
export async function completeSignIn(
  provider: ConnectorProvider,
  input: {
    userId: string;
    /** The OAuth 2 authorization code, or the OAuth 1.0a verifier. */
    code: string;
    /** The PKCE verifier (OAuth 2) or the request token as JSON (OAuth 1.0a), from the state cookie. */
    pending: string;
    /** OAuth 1.0a: the token the tool echoed back, which must be the one we asked for. */
    oauthToken?: string | null;
    request: Request;
  },
): Promise<string> {
  if (provider.oauth1) {
    const requested = JSON.parse(input.pending || "{}") as { token?: string; secret?: string };
    if (!requested.token || !requested.secret || requested.token !== input.oauthToken) {
      throw new ConnectorSignInError("tool_token");
    }
    const access = await oauth1AccessToken(provider, {
      token: requested.token,
      secret: requested.secret,
      verifier: input.code,
    });
    if (!access) throw new ConnectorSignInError("tool_token");

    const response = await fetch(identityRequestUrl(provider, access.token), { cache: "no-store" });
    const identity = response.ok ? provider.accountFrom(await response.json().catch(() => null)) : null;
    if (!identity) throw new ConnectorSignInError("tool_identity");

    return saveConnection(provider, input.userId, identity, {
      secret: { access_token: access.token, token_secret: access.secret },
      expiresAt: null,
    });
  }

  const tokens = await exchangeCode(
    provider,
    input.code,
    callbackUrl(provider, input.request),
    input.pending,
  );
  const identity = provider.identityFromToken
    ? provider.identityFromToken(tokens)
    : await readIdentity(provider, tokens.access_token);
  if (!identity) throw new ConnectorSignInError("tool_identity");

  const secret: Record<string, string> = { access_token: tokens.access_token };
  if (tokens.refresh_token) secret.refresh_token = tokens.refresh_token;

  return saveConnection(provider, input.userId, identity, {
    secret,
    expiresAt: tokens.expires_in ? new Date(Date.now() + tokens.expires_in * 1000) : null,
  });
}
