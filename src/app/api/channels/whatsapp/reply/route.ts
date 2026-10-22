import { NextResponse } from "next/server";
import { channelCallAuthorised } from "@/lib/channel-token";
import { resolveChannelUser, WHATSAPP } from "@/server/channel-links";
import { recordChannelTurn } from "@/server/conversation";
import { rememberInBackground } from "@/server/conversation-memory";

/**
 * Called by n8n after the orchestrator answers a WhatsApp message, so the reply
 * joins the person's WhatsApp conversation on the platform and the next message,
 * whichever tool answers it, knows what was said.
 *
 * Body: { "whatsappUserId": "...", "reply": "the answer sent" }. 404 when not linked.
 */
export async function POST(request: Request) {
  if (!channelCallAuthorised(request)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const body = (await request.json().catch(() => null)) as { whatsappUserId?: unknown; reply?: unknown } | null;
  const whatsappUserId = body?.whatsappUserId;
  if (typeof whatsappUserId !== "string" || !/^\d{1,20}$/.test(whatsappUserId) || typeof body?.reply !== "string") {
    return NextResponse.json({ error: "Bad request" }, { status: 400 });
  }
  const userId = await resolveChannelUser(WHATSAPP, whatsappUserId);
  if (!userId) return NextResponse.json({ error: "Not linked" }, { status: 404 });

  const { threadId } = await recordChannelTurn(userId, "whatsapp", "ASSISTANT", body.reply);
  // The turn is complete: index it and bring the summary up to date.
  await rememberInBackground(userId, threadId);
  return NextResponse.json({ ok: true });
}

export const dynamic = "force-dynamic";
