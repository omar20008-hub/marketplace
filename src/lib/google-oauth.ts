import "server-only";
import { createHash, randomBytes } from "node:crypto";
import { GOOGLE_DRIVE_CREDENTIAL } from "./credentials";
import { env } from "./env";
import { appUrl } from "./public-origin";

export { GOOGLE_DRIVE_CREDENTIAL, appUrl };

/**
 * Google OAuth for the connections the platform holds itself.
 *
 * The refresh token stays here, encrypted in ConnectedAccount.secretJson —
 * never in n8n, whose credential creation only knows plain key/value fields and
 * cannot renew an OAuth token. Whatever needs Drive asks the platform.
 *
 * Nothing here talks to the database; see server/google-account.ts.
 */

export const DRIVE_READONLY_SCOPE = "https://www.googleapis.com/auth/drive.readonly";

const SCOPES = ["openid", "email", DRIVE_READONLY_SCOPE];
const AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_URL = "https://oauth2.googleapis.com/token";
const REVOKE_URL = "https://oauth2.googleapis.com/revoke";

export type TokenSet = {
  accessToken: string;
  /** Google only sends one on a first consent (or when consent is forced). */
  refreshToken?: string;
  expiresAt: Date;
  scope: string[];
  idToken?: string;
};

/**
 * `permanent` is the one distinction callers need: invalid_grant means this
 * connection is dead and the user must reconnect. Anything else — a network
 * failure, a 5xx, a misconfigured client — says nothing about the user's
 * account, and must never be allowed to expire it.
 */
export class GoogleAuthError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly permanent: boolean,
  ) {
    super(message);
    this.name = "GoogleAuthError";
  }
}

export const GOOGLE_CALLBACK_PATH = "/api/oauth/google/callback";

/**
 * The redirect URI registered in Google Cloud. GOOGLE_REDIRECT_URI exactly as
 * given; failing that, the app's public address plus the callback path, so a
 * deployment that sets PUBLIC_URL does not also have to repeat it.
 */
export function googleRedirectUri(): string {
  if (env.google.redirectUri) return env.google.redirectUri;
  return env.publicUrl ? `${env.publicUrl}${GOOGLE_CALLBACK_PATH}` : "";
}

/**
 * Which of the settings Google sign-in needs are absent or unusable, by name. Never values:
 * the answer is safe to log, and to show the person who runs the deployment.
 */
export function googleMissingConfig(): string[] {
  const missing: string[] = [];
  if (!env.google.clientId) missing.push("GOOGLE_CLIENT_ID");
  if (!env.google.clientSecret) missing.push("GOOGLE_CLIENT_SECRET");
  if (!googleRedirectUri()) missing.push("GOOGLE_REDIRECT_URI");
  // The refresh token is stored encrypted with this key (lib/secrets.ts), which
  // insists on exactly 32 bytes as 64 hex characters. A key of any other shape
  // would only fail at the moment a connection is saved, after the user has
  // already consented at Google.
  if (!/^[0-9a-fA-F]{64}$/.test(env.secretsKey)) missing.push("SECRETS_KEY");
  return missing;
}

export function googleConfigured(): boolean {
  return googleMissingConfig().length === 0;
}

/** What the user is told when a connect attempt comes back with ?connect_error=. */
export const CONNECT_ERRORS: Record<string, string> = {
  not_configured: "Google sign-in is not set up on the server yet.",
  unavailable: "Google sign-in could not be started. Try again in a moment.",
  denied: "Google access was declined, so nothing was connected.",
  state: "That sign-in link expired or was not started here. Try connecting again.",
  scope:
    "Drive access was not granted. Tick the Drive permission on Google's screen and try again.",
  no_refresh:
    "Google did not issue a lasting connection. Remove this app at myaccount.google.com/permissions, then connect again.",
  identity: "Google did not confirm which account this is. Try connecting again.",
  google: "Google could not complete the connection. Try again in a moment.",
};

/**
 * The banner for a failed connect attempt.
 *
 * For "not configured" it names the settings that are missing, worked out here
 * from the server's own environment at the moment the page renders — not read
 * back from the URL, which anyone can edit. Names only: the point is to say what
 * to set, and a value never leaves the environment it was set in.
 */
export function connectErrorText(code: string | undefined): string {
  if (code === "not_configured") {
    const missing = googleMissingConfig();
    if (missing.length > 0) {
      return `Google sign-in is not set up on the server yet. Missing: ${missing.join(", ")}.`;
    }
  }
  return CONNECT_ERRORS[code ?? ""] ?? CONNECT_ERRORS.google;
}

export function pkcePair() {
  const verifier = randomBytes(32).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  return { verifier, challenge };
}

/**
 * offline + prompt=consent is what makes Google hand back a refresh token every
 * time, not just the first. Without it a reconnect returns none, and the
 * account can never be renewed.
 */
export function authorizationUrl({ state, challenge }: { state: string; challenge: string }) {
  const url = new URL(AUTH_URL);
  url.search = new URLSearchParams({
    client_id: env.google.clientId,
    redirect_uri: googleRedirectUri(),
    response_type: "code",
    scope: SCOPES.join(" "),
    access_type: "offline",
    prompt: "consent",
    include_granted_scopes: "true",
    state,
    code_challenge: challenge,
    code_challenge_method: "S256",
  }).toString();
  return url.toString();
}

async function tokenRequest(body: Record<string, string>): Promise<TokenSet> {
  const response = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: env.google.clientId,
      client_secret: env.google.clientSecret,
      ...body,
    }),
    cache: "no-store",
  });

  const json = (await response.json().catch(() => ({}))) as {
    access_token?: string;
    refresh_token?: string;
    expires_in?: number;
    scope?: string;
    id_token?: string;
    error?: string;
    error_description?: string;
  };

  if (!response.ok || !json.access_token) {
    const code = json.error ?? (response.status >= 500 ? "server_error" : "unknown");
    throw new GoogleAuthError(
      `Google token endpoint: ${code}${json.error_description ? ` — ${json.error_description}` : ""}`,
      code,
      code === "invalid_grant",
    );
  }

  return {
    accessToken: json.access_token,
    refreshToken: json.refresh_token,
    expiresAt: new Date(Date.now() + (json.expires_in ?? 3600) * 1000),
    scope: (json.scope ?? "").split(" ").filter(Boolean),
    idToken: json.id_token,
  };
}

export function exchangeCode(code: string, verifier: string) {
  return tokenRequest({
    grant_type: "authorization_code",
    code,
    redirect_uri: googleRedirectUri(),
    code_verifier: verifier,
  });
}

export function refreshAccessToken(refreshToken: string) {
  return tokenRequest({ grant_type: "refresh_token", refresh_token: refreshToken });
}

/** Best effort: a failed revoke must not stop a user disconnecting. */
export async function revokeToken(token: string): Promise<boolean> {
  try {
    const response = await fetch(REVOKE_URL, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ token }),
      cache: "no-store",
    });
    return response.ok;
  } catch {
    return false;
  }
}

/**
 * The id_token arrives straight from Google's token endpoint over TLS, so the
 * signature is not re-verified here — but whose it is still is: audience must be
 * this client, issuer Google, and the address verified.
 */
export function identityFromIdToken(idToken: string | undefined) {
  if (!idToken) return null;
  const part = idToken.split(".")[1];
  if (!part) return null;

  try {
    const claims = JSON.parse(Buffer.from(part, "base64url").toString("utf8")) as {
      aud?: string;
      iss?: string;
      email?: string;
      email_verified?: boolean;
      sub?: string;
    };
    const issuerOk =
      claims.iss === "https://accounts.google.com" || claims.iss === "accounts.google.com";
    if (!issuerOk || claims.aud !== env.google.clientId) return null;
    if (!claims.email || claims.email_verified !== true) return null;
    return { email: claims.email.toLowerCase(), sub: claims.sub ?? "" };
  } catch {
    return null;
  }
}
