import { NextResponse } from "next/server";
import { channelCallAuthorised } from "@/lib/channel-token";
import { publicOrigin } from "@/lib/public-origin";
import { resolveChannelUser, WHATSAPP } from "@/server/channel-links";
import { mediaPath, takeProofs } from "@/server/media";

/**
 * Called by n8n right after it sends the answer on WhatsApp: the pictures the assistant's browser took while
 * working on this message, each handed out once, as links WhatsApp can fetch. n8n sends them as images.
 *
 * Body: { "whatsappUserId": "..." }. Answer: { "items": [{ "url": "...", "caption": "..." }] }. 404 when not linked.
 */
export async function POST(request: Request) {
  if (!channelCallAuthorised(request)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const body = (await request.json().catch(() => null)) as { whatsappUserId?: unknown } | null;
  const whatsappUserId = body?.whatsappUserId;
  if (typeof whatsappUserId !== "string" || !/^\d{1,20}$/.test(whatsappUserId)) {
    return NextResponse.json({ error: "Bad request" }, { status: 400 });
  }
  const userId = await resolveChannelUser(WHATSAPP, whatsappUserId);
  if (!userId) return NextResponse.json({ error: "Not linked" }, { status: 404 });

  const origin = publicOrigin(request);
  const items = (await takeProofs(userId)).map((p) => ({
    url: new URL(mediaPath(p.token, p.kind), origin).toString(),
    caption: p.caption,
  }));
  return NextResponse.json({ items }, { headers: { "Cache-Control": "no-store" } });
}

export const dynamic = "force-dynamic";
