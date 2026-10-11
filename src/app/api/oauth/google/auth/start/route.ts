import { NextResponse } from "next/server";
import {
  GOOGLE_AUTH_CALLBACK_PATH,
  GOOGLE_LOGIN_SCOPES,
  appUrl,
  authorizationUrl,
  googleConfigured,
  pkcePair,
} from "@/lib/google-oauth";
import {
  OAUTH_COOKIE,
  OAUTH_COOKIE_PATH,
  OAUTH_STATE_TTL_SECONDS,
  newOAuthState,
  safeReturnTo,
} from "@/lib/oauth-state";

/**
 * Starts "Sign in with Google" for someone who is not signed in. Login needs
 * only the identity scopes, never Drive, and comes back to its own callback.
 */
export async function GET(request: Request) {
  const returnTo = safeReturnTo(new URL(request.url).searchParams.get("returnTo"), "/");

  if (!googleConfigured()) {
    return NextResponse.redirect(appUrl("/login", { auth_error: "not_configured" }, request));
  }

  try {
    const { verifier, challenge } = pkcePair();
    const { nonce, cookie } = newOAuthState({ userId: "", verifier, returnTo });
    const response = NextResponse.redirect(
      authorizationUrl({
        state: nonce,
        challenge,
        redirectUri: appUrl(GOOGLE_AUTH_CALLBACK_PATH, {}, request),
        scopes: GOOGLE_LOGIN_SCOPES,
      }),
    );
    response.cookies.set(OAUTH_COOKIE, cookie, {
      httpOnly: true,
      secure: process.env.NODE_ENV === "production",
      sameSite: "lax",
      path: OAUTH_COOKIE_PATH,
      maxAge: OAUTH_STATE_TTL_SECONDS,
    });
    return response;
  } catch (error) {
    console.error(
      `Google sign-in could not be started: ${error instanceof Error ? error.name : "unknown error"}`,
    );
    return NextResponse.redirect(appUrl("/login", { auth_error: "unavailable" }, request));
  }
}

export const dynamic = "force-dynamic";
