import { NextResponse } from "next/server";
import { requireUser } from "@/lib/auth";
import {
  FACEBOOK_CREDENTIAL,
  appUrl,
  exchangeCode,
  extendToken,
  readProfile,
} from "@/lib/facebook-oauth";
import {
  FACEBOOK_OAUTH_COOKIE,
  FACEBOOK_OAUTH_COOKIE_PATH,
  cookieValue,
  readOAuthState,
} from "@/lib/oauth-state";
import { saveFacebookConnection } from "@/server/facebook-account";

/**
 * Where Facebook sends the user back. Nothing here is trusted until the state
 * checks out: the nonce Facebook echoes has to match the signed cookie, and the
 * cookie has to have been issued to this same signed-in user.
 */
export async function GET(request: Request) {
  const user = await requireUser();
  const url = new URL(request.url);

  const finish = (path: string, params: Record<string, string>) => {
    const response = NextResponse.redirect(appUrl(path, params, request));
    // One use only, whichever way it ended.
    response.cookies.set(FACEBOOK_OAUTH_COOKIE, "", {
      path: FACEBOOK_OAUTH_COOKIE_PATH,
      maxAge: 0,
    });
    return response;
  };

  const state = readOAuthState(
    cookieValue(request.headers.get("cookie"), FACEBOOK_OAUTH_COOKIE),
    url.searchParams.get("state"),
    user.id,
  );
  if (!state) return finish("/accounts", { connect_error: "state" });

  if (url.searchParams.get("error")) {
    return finish(state.returnTo, { connect_error: "fb_denied" });
  }

  const code = url.searchParams.get("code");
  if (!code) return finish(state.returnTo, { connect_error: "fb_failed" });

  try {
    const token = await extendToken(await exchangeCode(code));
    const profile = await readProfile(token.accessToken);
    if (!profile.id) return finish(state.returnTo, { connect_error: "fb_identity" });

    const saved = await saveFacebookConnection({ userId: user.id, profile, token });
    if (!saved.ok) {
      return finish(state.returnTo, {
        connect_error: saved.reason === "scope" ? "fb_scope" : "fb_no_pages",
      });
    }
    return finish(state.returnTo, { connected: FACEBOOK_CREDENTIAL });
  } catch (error) {
    // The message is Facebook's own and carries no token; the token never reaches a log.
    console.error("Facebook connect failed", error instanceof Error ? error.message : error);
    return finish(state.returnTo, { connect_error: "fb_failed" });
  }
}

export const dynamic = "force-dynamic";
