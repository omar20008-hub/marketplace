import { NextResponse } from "next/server";
import { channelCallAuthorised } from "@/lib/channel-token";
import { formatHistory, searchConversation } from "@/server/conversation-memory";

/**
 * The n8n Orchestrator's "search the conversation" tool: the messages from all of
 * the person's past conversations (platform and WhatsApp) that match a query.
 * n8n names the person by the user id it put in the chat session itself.
 *
 * Body: { "userId": "...", "query": "..." }. Returns { results, text }.
 */
export async function POST(request: Request) {
  if (!channelCallAuthorised(request)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const body = (await request.json().catch(() => null)) as { userId?: unknown; query?: unknown } | null;
  const userId = typeof body?.userId === "string" ? body.userId.split("|")[0] : "";
  if (!/^[a-z0-9]{20,40}$/.test(userId) || typeof body?.query !== "string" || !body.query.trim()) {
    return NextResponse.json({ error: "Bad request" }, { status: 400 });
  }
  const results = await searchConversation(userId, body.query);
  return NextResponse.json({ results, text: formatHistory(results) });
}

export const dynamic = "force-dynamic";
