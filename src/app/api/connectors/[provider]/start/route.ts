import { NextResponse } from "next/server";
import { requireUser } from "@/lib/auth";
import { appUrl } from "@/lib/public-origin";
import { findProvider, missingSettings } from "@/lib/connectors/providers";
import { beginSignIn, connectorCookieName, connectorCookiePath } from "@/lib/connectors/sign-in";
import { safeReturnTo } from "@/lib/oauth-state";

/**
 * Sends the signed-in person to a tool's own sign-in, to connect it.
 *
 * A plain link, like the Google one: a prefetch on hover would start a sign-in
 * nobody asked for. Every failure before the tool itself puts the person back
 * where they were, with a reason in the URL and a line in the server log.
 */
export async function GET(request: Request, { params }: { params: Promise<{ provider: string }> }) {
  const user = await requireUser();
  const provider = findProvider((await params).provider);
  if (!provider) return new NextResponse("Unknown connector", { status: 404 });

  const returnTo = safeReturnTo(new URL(request.url).searchParams.get("returnTo"));

  const missing = missingSettings(provider);
  if (missing.length > 0) {
    console.error(`${provider.displayName} sign-in is not configured; missing settings: ${missing.join(", ")}`);
    return NextResponse.redirect(appUrl(returnTo, { connect_error: "tool_not_configured" }, request));
  }

  const { url, cookie, cookieMaxAge } = beginSignIn(provider, { userId: user.id, returnTo, request });
  const response = NextResponse.redirect(url);
  response.cookies.set(connectorCookieName(provider), cookie, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: connectorCookiePath(provider),
    maxAge: cookieMaxAge,
  });
  return response;
}

export const dynamic = "force-dynamic";
