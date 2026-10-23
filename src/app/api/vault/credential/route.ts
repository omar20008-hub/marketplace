import { NextResponse } from "next/server";
import { hit } from "@/lib/rate-limit";
import { bearerToken, userForAgentKey } from "@/server/agent-keys";
import { fillSiteLogin } from "@/server/site-logins";

/**
 * Called by the server path that drives the browser, just before it types a
 * saved login into a form. This is the only response that carries a password.
 * It is never logged, never stored, and never returned to a page.
 *
 * The person is the one the Authorization key belongs to. A user id in the
 * body is not read: whoever holds a shared secret must not be able to pick
 * whose password to take.
 *
 * Body: { "siteUrl": "https://...", "username": "optional" }.
 */
export async function POST(request: Request) {
  const userId = await userForAgentKey(bearerToken(request));
  if (!userId) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const body = (await request.json().catch(() => null)) as
    | { siteUrl?: unknown; username?: unknown }
    | null;
  if (typeof body?.siteUrl !== "string") {
    return NextResponse.json({ error: "Bad request" }, { status: 400 });
  }
  const username = typeof body.username === "string" ? body.username : undefined;

  const limit = hit(`vault-fill:${userId}`, { limit: 60, windowMs: 60 * 60_000 });
  if (!limit.ok) return NextResponse.json({ error: "rate_limited" }, { status: 429 });

  const result = await fillSiteLogin({ userId, siteUrl: body.siteUrl, username });
  if ("error" in result) {
    const status = result.error === "invalid" ? 400 : result.error === "none" ? 404 : 409;
    return NextResponse.json({ error: result.error }, { status });
  }
  return NextResponse.json(result, { headers: { "Cache-Control": "no-store" } });
}

export const dynamic = "force-dynamic";
