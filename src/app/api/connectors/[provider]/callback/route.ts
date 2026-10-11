import { NextResponse } from "next/server";
import { requireUser } from "@/lib/auth";
import { appUrl } from "@/lib/public-origin";
import { findProvider } from "@/lib/connectors/providers";
import {
  ConnectorSignInError,
  completeSignIn,
  connectorCookieName,
  connectorCookiePath,
} from "@/lib/connectors/sign-in";
import { cookieValue, readOAuthState } from "@/lib/oauth-state";

/**
 * Where a tool sends the person back. Nothing here is trusted until the state
 * checks out: the nonce the tool echoes must match this provider's signed cookie,
 * and that cookie must have been issued to this same signed-in user.
 */
export async function GET(request: Request, { params }: { params: Promise<{ provider: string }> }) {
  const user = await requireUser();
  const provider = findProvider((await params).provider);
  if (!provider) return new NextResponse("Unknown connector", { status: 404 });

  const url = new URL(request.url);
  const cookieName = connectorCookieName(provider);
  const finish = (path: string, query: Record<string, string>) => {
    const response = NextResponse.redirect(appUrl(path, query, request));
    // One use only, whichever way it ended.
    response.cookies.set(cookieName, "", { path: connectorCookiePath(provider), maxAge: 0 });
    return response;
  };

  const state = readOAuthState(
    cookieValue(request.headers.get("cookie"), cookieName),
    url.searchParams.get("state"),
    user.id,
  );
  if (!state) return finish("/accounts", { connect_error: "tool_state" });

  if (url.searchParams.get("error")) return finish(state.returnTo, { connect_error: "tool_denied" });

  const code = url.searchParams.get("code");
  if (!code) return finish(state.returnTo, { connect_error: "tool_failed" });

  try {
    await completeSignIn(provider, { userId: user.id, code, request });
    return finish(state.returnTo, { connected: provider.credentialType });
  } catch (error) {
    const reason = error instanceof ConnectorSignInError ? error.code : "tool_failed";
    console.error(`${provider.displayName} sign-in failed: ${reason}`);
    return finish(state.returnTo, { connect_error: reason });
  }
}

export const dynamic = "force-dynamic";
