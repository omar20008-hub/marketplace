import "server-only";
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { env } from "./env";

/**
 * The state of a sign-in that is in flight, kept in a signed httpOnly cookie
 * rather than the database: it lives ten minutes, belongs to one browser, and
 * carries the PKCE verifier, which must never travel through Google's redirect.
 *
 * The `state` query parameter Google echoes back is only the nonce. It has to
 * match the cookie, and the cookie has to have been issued to the same signed-in
 * user — so a link someone else started cannot be finished in your session.
 */

export const OAUTH_COOKIE = "g_oauth";
export const OAUTH_COOKIE_PATH = "/api/oauth/google";
export const OAUTH_STATE_TTL_SECONDS = 600;

type Payload = {
  nonce: string;
  userId: string;
  verifier: string;
  returnTo: string;
  exp: number;
};

function sign(body: string) {
  return createHmac("sha256", env.authSecret).update(`oauth-state:${body}`).digest("base64url");
}

function equal(a: string, b: string) {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

/** Only ever a path on this app — never somewhere the sign-in could be bounced to. */
export function safeReturnTo(value: string | null | undefined, fallback = "/accounts") {
  if (!value || !value.startsWith("/") || value.startsWith("//") || value.includes("\\")) {
    return fallback;
  }
  return value;
}

export function newOAuthState(input: { userId: string; verifier: string; returnTo: string }) {
  const nonce = randomBytes(16).toString("base64url");
  const payload: Payload = {
    nonce,
    userId: input.userId,
    verifier: input.verifier,
    returnTo: safeReturnTo(input.returnTo),
    exp: Date.now() + OAUTH_STATE_TTL_SECONDS * 1000,
  };
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  return { nonce, cookie: `${body}.${sign(body)}` };
}

export function readOAuthState(
  cookie: string | undefined,
  nonce: string | null,
  userId: string,
): Payload | null {
  if (!cookie || !nonce) return null;
  const [body, signature] = cookie.split(".");
  if (!body || !signature || !equal(signature, sign(body))) return null;

  try {
    const payload = JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as Payload;
    if (payload.exp < Date.now()) return null;
    if (!equal(payload.nonce, nonce)) return null;
    if (payload.userId !== userId) return null;
    return { ...payload, returnTo: safeReturnTo(payload.returnTo) };
  } catch {
    return null;
  }
}

/** Reads one cookie off a raw Cookie header, so a route needs no next/headers. */
export function cookieValue(header: string | null, name: string): string | undefined {
  if (!header) return undefined;
  for (const part of header.split(";")) {
    const index = part.indexOf("=");
    if (index === -1) continue;
    if (part.slice(0, index).trim() === name) return part.slice(index + 1).trim();
  }
  return undefined;
}
