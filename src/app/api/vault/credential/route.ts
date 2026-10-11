import { NextResponse } from "next/server";
import { channelCallAuthorised } from "@/lib/channel-token";
import { hit } from "@/lib/rate-limit";
import { fillSiteLogin } from "@/server/site-logins";

/**
 * Called by the server path that drives the browser, just before it types a
 * saved login into a form. This is the only response that carries a password.
 * It is never logged, never stored, and never returned to a page.
 * Body: { "userId": "...", "siteUrl": "https://...", "username": "optional" }.
 */
export async function POST(request: Request) {
  if (!channelCallAuthorised(request)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const body = (await request.json().catch(() => null)) as
    | { userId?: unknown; siteUrl?: unknown; username?: unknown }
    | null;
  if (typeof body?.userId !== "string" || typeof body?.siteUrl !== "string") {
    return NextResponse.json({ error: "Bad request" }, { status: 400 });
  }
  const username = typeof body.username === "string" ? body.username : undefined;

  const limit = hit(`vault-fill:${body.userId}`, { limit: 60, windowMs: 60 * 60_000 });
  if (!limit.ok) return NextResponse.json({ error: "rate_limited" }, { status: 429 });

  const result = await fillSiteLogin({ userId: body.userId, siteUrl: body.siteUrl, username });
  if ("error" in result) {
    const status = result.error === "invalid" ? 400 : result.error === "none" ? 404 : 409;
    return NextResponse.json({ error: result.error }, { status });
  }
  return NextResponse.json(result, { headers: { "Cache-Control": "no-store" } });
}

export const dynamic = "force-dynamic";
