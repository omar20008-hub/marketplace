import "server-only";
import { env } from "./env";
import { FACEBOOK_CREDENTIAL } from "./credentials";
import { appUrl } from "./public-origin";

export { FACEBOOK_CREDENTIAL, appUrl };

/**
 * "Continue with Facebook": the sign-in that connects Facebook Pages and the
 * Instagram Business account linked to one.
 *
 * What comes back is a user access token. It is swapped for a long-lived one
 * (about 60 days) and kept, encrypted, as the user's Facebook & Instagram
 * connection — the same shape a pasted token has, so the install path does not
 * care which way it got here. Facebook has no refresh token: when the 60 days
 * run out the connection is marked expired and the user signs in again.
 *
 * Nothing here talks to the database; see server/facebook-account.ts.
 */

export const GRAPH = "https://graph.facebook.com/v21.0";
const DIALOG_URL = "https://www.facebook.com/v21.0/dialog/oauth";

export const FACEBOOK_CALLBACK_PATH = "/api/oauth/facebook/callback";

/** Without these three the product cannot post to a Page at all. */
export const REQUIRED_SCOPES = ["pages_show_list", "pages_read_engagement", "pages_manage_posts"];
/** Asked for, but declining them only costs Instagram. */
export const INSTAGRAM_SCOPES = ["instagram_basic", "instagram_content_publish"];
export const SCOPES = [...REQUIRED_SCOPES, ...INSTAGRAM_SCOPES];

/** Facebook said no, or answered in a way that means this attempt cannot continue. */
export class FacebookAuthError extends Error {
  constructor(
    message: string,
    readonly code: string,
  ) {
    super(message);
    this.name = "FacebookAuthError";
  }
}

export function facebookRedirectUri(): string {
  if (env.facebook.redirectUri) return env.facebook.redirectUri;
  return env.publicUrl ? `${env.publicUrl}${FACEBOOK_CALLBACK_PATH}` : "";
}

/** Which settings the sign-in needs are absent, by name — never values. */
export function facebookMissingConfig(): string[] {
  const missing: string[] = [];
  if (!env.facebook.appId) missing.push("FACEBOOK_APP_ID");
  if (!env.facebook.appSecret) missing.push("FACEBOOK_APP_SECRET");
  if (!facebookRedirectUri()) missing.push("PUBLIC_URL");
  if (!/^[0-9a-fA-F]{64}$/.test(env.secretsKey)) missing.push("SECRETS_KEY");
  return missing;
}

export function facebookConfigured(): boolean {
  return facebookMissingConfig().length === 0;
}

/** What the user is told when a Facebook connect attempt comes back with ?connect_error=. */
export const FACEBOOK_CONNECT_ERRORS: Record<string, string> = {
  fb_not_configured:
    "Facebook sign-in is not set up on the server yet. You can paste an access token instead.",
  fb_unavailable: "Facebook sign-in could not be started. Try again in a moment.",
  fb_denied: "Facebook access was declined, so nothing was connected.",
  fb_scope:
    "Facebook did not grant permission to post to your Pages. Tick every permission on Facebook's screen and choose a Page, then try again.",
  fb_no_pages:
    "No Facebook Page came back for this account. Sign in again and select the Page you want to post to.",
  fb_identity: "Facebook did not confirm which account this is. Try connecting again.",
  fb_failed: "Facebook could not complete the connection. Try again in a moment.",
};

export function isFacebookConnectError(code: string | undefined): boolean {
  return !!code && code in FACEBOOK_CONNECT_ERRORS;
}

export function facebookConnectErrorText(code: string | undefined): string {
  if (code === "fb_not_configured") {
    const missing = facebookMissingConfig();
    if (missing.length > 0) {
      return `Facebook sign-in is not set up on the server yet. Missing: ${missing.join(", ")}. You can paste an access token instead.`;
    }
  }
  return FACEBOOK_CONNECT_ERRORS[code ?? ""] ?? FACEBOOK_CONNECT_ERRORS.fb_failed;
}

export function authorizationUrl({ state }: { state: string }) {
  const url = new URL(DIALOG_URL);
  url.search = new URLSearchParams({
    client_id: env.facebook.appId,
    redirect_uri: facebookRedirectUri(),
    response_type: "code",
    scope: SCOPES.join(","),
    state,
  }).toString();
  return url.toString();
}

async function graph<T>(path: string, params: Record<string, string>): Promise<T> {
  const url = new URL(`${GRAPH}${path}`);
  url.search = new URLSearchParams(params).toString();
  const response = await fetch(url, { cache: "no-store" });
  const json = (await response.json().catch(() => ({}))) as T & {
    error?: { message?: string; code?: number; type?: string };
  };
  if (!response.ok || json.error) {
    const detail = json.error?.message ?? `HTTP ${response.status}`;
    throw new FacebookAuthError(`Facebook: ${detail}`, String(json.error?.code ?? response.status));
  }
  return json;
}

/** The short-lived token the sign-in hands back for a code. */
export async function exchangeCode(code: string): Promise<string> {
  const json = await graph<{ access_token?: string }>("/oauth/access_token", {
    client_id: env.facebook.appId,
    client_secret: env.facebook.appSecret,
    redirect_uri: facebookRedirectUri(),
    code,
  });
  if (!json.access_token) throw new FacebookAuthError("Facebook sent no access token.", "no_token");
  return json.access_token;
}

export type LongLivedToken = { accessToken: string; expiresAt: Date | null };

/** Swaps the hour-long token for one that lasts about 60 days. */
export async function extendToken(shortLived: string): Promise<LongLivedToken> {
  const json = await graph<{ access_token?: string; expires_in?: number }>("/oauth/access_token", {
    grant_type: "fb_exchange_token",
    client_id: env.facebook.appId,
    client_secret: env.facebook.appSecret,
    fb_exchange_token: shortLived,
  });
  if (!json.access_token) throw new FacebookAuthError("Facebook sent no access token.", "no_token");
  return {
    accessToken: json.access_token,
    // Some tokens come back without a lifetime; they do not expire on a schedule.
    expiresAt: json.expires_in ? new Date(Date.now() + json.expires_in * 1000) : null,
  };
}

export type FacebookProfile = {
  id: string;
  name: string;
  /** Permissions the user actually granted — they can untick any on Facebook's screen. */
  granted: string[];
  pages: { id: string; name: string; instagram: boolean }[];
};

export async function readProfile(accessToken: string): Promise<FacebookProfile> {
  const [me, permissions, accounts] = await Promise.all([
    graph<{ id?: string; name?: string }>("/me", { fields: "id,name", access_token: accessToken }),
    graph<{ data?: { permission: string; status: string }[] }>("/me/permissions", {
      access_token: accessToken,
    }),
    graph<{ data?: { id: string; name: string; instagram_business_account?: { id: string } }[] }>(
      "/me/accounts",
      { fields: "id,name,instagram_business_account", access_token: accessToken },
    ),
  ]);

  return {
    id: me.id ?? "",
    name: me.name ?? "",
    granted: (permissions.data ?? []).filter((p) => p.status === "granted").map((p) => p.permission),
    pages: (accounts.data ?? []).map((page) => ({
      id: page.id,
      name: page.name,
      instagram: !!page.instagram_business_account?.id,
    })),
  };
}

export function hasRequiredScopes(granted: string[]): boolean {
  return REQUIRED_SCOPES.every((scope) => granted.includes(scope));
}
