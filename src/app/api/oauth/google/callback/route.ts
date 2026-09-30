import { NextResponse } from "next/server";
import { requireUser } from "@/lib/auth";
import {
  GOOGLE_DRIVE_CREDENTIAL,
  appUrl,
  exchangeCode,
  identityFromIdToken,
} from "@/lib/google-oauth";
import {
  OAUTH_COOKIE,
  OAUTH_COOKIE_PATH,
  cookieValue,
  readOAuthState,
} from "@/lib/oauth-state";
import { saveGoogleConnection } from "@/server/google-account";

/**
 * Where Google sends the user back. Nothing here is trusted until the state
 * checks out: the nonce Google echoes has to match the signed cookie, and the
 * cookie has to have been issued to this same signed-in user.
 */
export async function GET(request: Request) {
  const user = await requireUser();
  const url = new URL(request.url);

  const finish = (path: string, params: Record<string, string>) => {
    const response = NextResponse.redirect(appUrl(path, params, request));
    // One use only, whichever way it ended.
    response.cookies.set(OAUTH_COOKIE, "", { path: OAUTH_COOKIE_PATH, maxAge: 0 });
    return response;
  };

  const state = readOAuthState(
    cookieValue(request.headers.get("cookie"), OAUTH_COOKIE),
    url.searchParams.get("state"),
    user.id,
  );
  if (!state) return finish("/accounts", { connect_error: "state" });

  if (url.searchParams.get("error")) {
    return finish(state.returnTo, { connect_error: "denied" });
  }

  const code = url.searchParams.get("code");
  if (!code) return finish(state.returnTo, { connect_error: "google" });

  try {
    const tokens = await exchangeCode(code, state.verifier);
    const identity = identityFromIdToken(tokens.idToken);
    if (!identity) return finish(state.returnTo, { connect_error: "identity" });

    const saved = await saveGoogleConnection({
      userId: user.id,
      email: identity.email,
      tokens,
    });
    if (!saved.ok) return finish(state.returnTo, { connect_error: saved.reason });

    return finish(state.returnTo, { connected: GOOGLE_DRIVE_CREDENTIAL });
  } catch (error) {
    console.error("Google connect failed", error instanceof Error ? error.message : error);
    return finish(state.returnTo, { connect_error: "google" });
  }
}

export const dynamic = "force-dynamic";
