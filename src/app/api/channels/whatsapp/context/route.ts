import { NextResponse } from "next/server";
import { channelCallAuthorised } from "@/lib/channel-token";
import { publicOrigin } from "@/lib/public-origin";
import { resolveChannelUser, WHATSAPP } from "@/server/channel-links";
import { channelThread, recordChannelTurn, withConversation } from "@/server/conversation";
import { withFiles } from "@/server/files/user-files";
import { withMemories } from "@/server/memory";

/**
 * Called by n8n before a WhatsApp message goes to the orchestrator. Stores the
 * message in the person's WhatsApp conversation on the platform, and returns it
 * with what the platform keeps for them in front of it: the recent turns of the
 * conversation, their memory files, and their saved files (with links to the
 * originals and the passages that match the message). Whatever then answers it
 * (the orchestrator, the personal assistant, a workflow) sees the same context.
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

  // The turns so far, then this message joins them (as typed, with the names of
  // any files it carried, never the file text or the blocks added here).
  const thread = await channelThread(userId, "whatsapp");
  const withContext = await withConversation(
    userId,
    thread.id,
    await withMemories(userId, await withFiles(userId, text, chatInput, { origin: publicOrigin(request) })),
  );
  const attached = [...chatInput.matchAll(/\[The user attached the file "([^"]+)"/g)].map((m) => `Attached file: ${m[1]}`);
  await recordChannelTurn(userId, "whatsapp", "USER", [text, ...attached].join("\n"));

  return NextResponse.json({ chatInput: withContext });
}

export const dynamic = "force-dynamic";
