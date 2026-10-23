import { NextResponse } from "next/server";
import { hit } from "@/lib/rate-limit";
import { bearerToken, userForAgentKey } from "@/server/agent-keys";
import { resolveSiteLoginById } from "@/server/site-logins";

/**
 * Returns one saved login's password to the person's own assistant, by handle.
 * It is never logged and never stored. The person is the key's owner; another
 * person's handle resolves to nothing.
 *
 * Body: { "id": "..." }.
 */
export async function POST(request: Request) {
  const userId = await userForAgentKey(bearerToken(request));
  if (!userId) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const body = (await request.json().catch(() => null)) as { id?: unknown } | null;
  if (typeof body?.id !== "string" || !body.id) {
    return NextResponse.json({ error: "Bad request" }, { status: 400 });
  }
  const limit = hit(`vault-fill:${userId}`, { limit: 60, windowMs: 60 * 60_000 });
  if (!limit.ok) return NextResponse.json({ error: "rate_limited" }, { status: 429 });

  const result = await resolveSiteLoginById({ userId, id: body.id });
  if (!result) return NextResponse.json({ error: "none" }, { status: 404 });
  return NextResponse.json(result, { headers: { "Cache-Control": "no-store" } });
}

export const dynamic = "force-dynamic";
