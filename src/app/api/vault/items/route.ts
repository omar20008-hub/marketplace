import { NextResponse } from "next/server";
import { bearerToken, userForAgentKey } from "@/server/agent-keys";
import { listSiteLogins } from "@/server/site-logins";

/**
 * The personal assistant's list of saved logins: handles and metadata only.
 * No password is ever in this response, so it can be shown to the model.
 */
export async function GET(request: Request) {
  const userId = await userForAgentKey(bearerToken(request));
  if (!userId) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const rows = await listSiteLogins(userId);
  const items = rows.map((r) => ({
    id: r.id,
    kind: "login",
    label: `${r.username} @ ${r.host}`,
    origin: `https://${r.host}`,
    username: r.username,
    siteUrl: r.siteUrl,
    lastUsedAt: r.lastUsedAt?.toISOString() ?? null,
  }));
  return NextResponse.json({ items }, { headers: { "Cache-Control": "no-store" } });
}

export const dynamic = "force-dynamic";
