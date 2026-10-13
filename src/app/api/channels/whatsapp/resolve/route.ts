import { NextResponse } from "next/server";
import { channelCallAuthorised } from "@/lib/channel-token";
import { resolveChannelUser, WHATSAPP } from "@/server/channel-links";

/**
 * Called by n8n before it hands a WhatsApp message to the orchestrator, so the
 * conversation runs as the linked platform user. Body: { "whatsappUserId": "..." }.
 * 404 when the chat is not linked; the caller should then refuse to answer.
 */
export async function POST(request: Request) {
  if (!channelCallAuthorised(request)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Bad request" }, { status: 400 });
  }
  const whatsappUserId = (body as { whatsappUserId?: unknown } | null)?.whatsappUserId;
  if (typeof whatsappUserId !== "string" || !/^\d{1,20}$/.test(whatsappUserId)) {
    return NextResponse.json({ error: "Bad request" }, { status: 400 });
  }

  const userId = await resolveChannelUser(WHATSAPP, whatsappUserId);
  if (!userId) return NextResponse.json({ error: "Not linked" }, { status: 404 });
  return NextResponse.json({ userId });
}

export const dynamic = "force-dynamic";
