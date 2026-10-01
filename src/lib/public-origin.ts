import "server-only";
import { env } from "./env";

/**
 * The address people reach this app at, for building links that leave a request
 * handler — redirects above all.
 *
 * It is NOT `new URL(request.url).origin`. Behind a proxy (Railway, any load
 * balancer) the server sees its own listening address, so the standalone build
 * reports `0.0.0.0:8080` and a redirect built from it sends the browser to a
 * host that exists only inside the container.
 *
 * In order of trust:
 *  1. PUBLIC_URL, or the origin of GOOGLE_REDIRECT_URI (see env.publicUrl) —
 *     what the operator said the app's address is.
 *  2. The proxy's own x-forwarded-host / x-forwarded-proto, when present and
 *     well-formed. They only ever shape the redirect for the request that carried
 *     them, so a forged one costs its sender nothing but a bad redirect for
 *     themselves.
 *  3. request.url, which is right only when nothing sits in front of the app.
 */

const HOST = /^[A-Za-z0-9]([A-Za-z0-9.-]*[A-Za-z0-9])?(:\d{1,5})?$/;

function first(value: string | null): string | null {
  return value?.split(",")[0]?.trim() || null;
}

export function publicOrigin(request: Request): string {
  if (env.publicUrl) {
    try {
      return new URL(env.publicUrl).origin;
    } catch {
      // A malformed PUBLIC_URL is the operator's mistake; fall through to
      // something that still works rather than failing every redirect.
    }
  }

  const host = first(request.headers.get("x-forwarded-host"));
  const proto = first(request.headers.get("x-forwarded-proto"));
  if (host && HOST.test(host) && (proto === "https" || proto === "http")) {
    return `${proto}://${host}`;
  }

  return new URL(request.url).origin;
}

/** A path on this app as an absolute URL that survives sitting behind a proxy. */
export function appUrl(path: string, params: Record<string, string>, request: Request): string {
  const url = new URL(path, publicOrigin(request));
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
  return url.toString();
}
