import { NextResponse } from "next/server";
import { channelCallAuthorised } from "@/lib/channel-token";
import { resolveChannelUser, WHATSAPP } from "@/server/channel-links";
import { withFiles } from "@/server/files/user-files";
import { withMemories } from "@/server/memory";

/**
 * Called by n8n before a WhatsApp message goes to the orchestrator: returns the
 * message with what the platform keeps for this person in front of it (their
 * memory files, and their saved files with the passages that match the message),
 * the same as a message sent in the platform chat gets.
 *
 * Body: { "whatsappUserId": "...", "text": "what they wrote", "chatInput": "text plus any file note" }.
 * `chatInput` defaults to `text`. 404 when the chat is not linked.
 */
export async function POST(request: Request) {
  if (!channelCallAuthorised(request)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  let body: { whatsappUserId?: unknown; text?: unknown; chatInput?: unknown } | null;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Bad request" }, { status: 400 });
  }
  const whatsappUserId = body?.whatsappUserId;
  const text = typeof body?.text === "string" ? body.text.slice(0, 20_000) : null;
  const chatInput = typeof body?.chatInput === "string" ? body.chatInput.slice(0, 60_000) : text;
  if (typeof whatsappUserId !== "string" || !/^\d{1,20}$/.test(whatsappUserId) || text === null || !chatInput) {
    return NextResponse.json({ error: "Bad request" }, { status: 400 });
  }

  const userId = await resolveChannelUser(WHATSAPP, whatsappUserId);
  if (!userId) return NextResponse.json({ error: "Not linked" }, { status: 404 });

  return NextResponse.json({ chatInput: await withMemories(userId, await withFiles(userId, text, chatInput)) });
}

export const dynamic = "force-dynamic";
