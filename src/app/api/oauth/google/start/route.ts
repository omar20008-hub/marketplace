import { NextResponse } from "next/server";
import { requireUser } from "@/lib/auth";
import { appUrl, authorizationUrl, googleConfigured, pkcePair } from "@/lib/google-oauth";
import {
  OAUTH_COOKIE,
  OAUTH_COOKIE_PATH,
  OAUTH_STATE_TTL_SECONDS,
  newOAuthState,
  safeReturnTo,
} from "@/lib/oauth-state";

/**
 * Sends the signed-in user to Google to connect Drive.
 *
 * Reached by a plain link (see ButtonAnchor), not next/link: a prefetch on hover
 * would start a sign-in nobody asked for. `returnTo` is where the callback puts
 * them back afterwards — a path on this app, checked, never a full URL.
 */
export async function GET(request: Request) {
  const user = await requireUser();
  const returnTo = safeReturnTo(new URL(request.url).searchParams.get("returnTo"));

  if (!googleConfigured()) {
    return NextResponse.redirect(appUrl(returnTo, { connect_error: "not_configured" }, request));
  }

  const { verifier, challenge } = pkcePair();
  const { nonce, cookie } = newOAuthState({ userId: user.id, verifier, returnTo });

  const response = NextResponse.redirect(authorizationUrl({ state: nonce, challenge }));
  response.cookies.set(OAUTH_COOKIE, cookie, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: OAUTH_COOKIE_PATH,
    maxAge: OAUTH_STATE_TTL_SECONDS,
  });
  return response;
}

export const dynamic = "force-dynamic";
