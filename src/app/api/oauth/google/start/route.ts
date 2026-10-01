import { NextResponse } from "next/server";
import { requireUser } from "@/lib/auth";
import { appUrl, authorizationUrl, googleMissingConfig, pkcePair } from "@/lib/google-oauth";
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

  // Every way out of here but Google itself puts the person back where they
  // were with a message, and leaves a line in the server log saying why. A
  // redirect that does nothing visible is the failure that is hardest to find.
  const missing = googleMissingConfig();
  if (missing.length > 0) {
    console.error(`Google sign-in is not configured; missing settings: ${missing.join(", ")}`);
    return NextResponse.redirect(
      appUrl(returnTo, { connect_error: "not_configured", connect_missing: missing.join(",") }, request),
    );
  }

  let response: NextResponse;
  try {
    const { verifier, challenge } = pkcePair();
    const { nonce, cookie } = newOAuthState({ userId: user.id, verifier, returnTo });
    response = NextResponse.redirect(authorizationUrl({ state: nonce, challenge }));
    response.cookies.set(OAUTH_COOKIE, cookie, {
      httpOnly: true,
      secure: process.env.NODE_ENV === "production",
      sameSite: "lax",
      path: OAUTH_COOKIE_PATH,
      maxAge: OAUTH_STATE_TTL_SECONDS,
    });
  } catch (error) {
    console.error(
      `Google sign-in could not be started: ${error instanceof Error ? error.name : "unknown error"}`,
    );
    return NextResponse.redirect(appUrl(returnTo, { connect_error: "unavailable" }, request));
  }
  return response;
}

export const dynamic = "force-dynamic";
