import { NextResponse } from "next/server";
import { requireUser } from "@/lib/auth";
import { appUrl, authorizationUrl, facebookMissingConfig } from "@/lib/facebook-oauth";
import {
  FACEBOOK_OAUTH_COOKIE,
  FACEBOOK_OAUTH_COOKIE_PATH,
  OAUTH_STATE_TTL_SECONDS,
  newOAuthState,
  safeReturnTo,
} from "@/lib/oauth-state";

/**
 * Sends the signed-in user to Facebook to connect their Pages and Instagram.
 *
 * Reached by a plain link, not next/link: a prefetch on hover would start a
 * sign-in nobody asked for. Every way out of here but Facebook itself puts the
 * person back where they were with a message and a line in the server log.
 */
export async function GET(request: Request) {
  const user = await requireUser();
  const returnTo = safeReturnTo(new URL(request.url).searchParams.get("returnTo"));

  const missing = facebookMissingConfig();
  if (missing.length > 0) {
    console.error(`Facebook sign-in is not configured; missing settings: ${missing.join(", ")}`);
    return NextResponse.redirect(appUrl(returnTo, { connect_error: "fb_not_configured" }, request));
  }

  try {
    // Facebook's code flow has no PKCE; the state cookie below is what ties the
    // callback to this browser and this user.
    const { nonce, cookie } = newOAuthState({ userId: user.id, verifier: "-", returnTo });
    const response = NextResponse.redirect(authorizationUrl({ state: nonce }));
    response.cookies.set(FACEBOOK_OAUTH_COOKIE, cookie, {
      httpOnly: true,
      secure: process.env.NODE_ENV === "production",
      sameSite: "lax",
      path: FACEBOOK_OAUTH_COOKIE_PATH,
      maxAge: OAUTH_STATE_TTL_SECONDS,
    });
    return response;
  } catch (error) {
    console.error(
      `Facebook sign-in could not be started: ${error instanceof Error ? error.name : "unknown error"}`,
    );
    return NextResponse.redirect(appUrl(returnTo, { connect_error: "fb_unavailable" }, request));
  }
}

export const dynamic = "force-dynamic";
