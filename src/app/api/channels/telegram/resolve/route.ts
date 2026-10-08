import { NextResponse } from "next/server";
import { channelCallAuthorised } from "@/lib/channel-token";
import { resolveTelegramUser } from "@/server/channel-links";

/**
 * Called by n8n before it hands a Telegram message to the orchestrator, so the
 * conversation runs as the linked platform user. Body: { "telegramUserId": "..." }.
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
  const telegramUserId = (body as { telegramUserId?: unknown } | null)?.telegramUserId;
  if (typeof telegramUserId !== "string" || !/^\d{1,20}$/.test(telegramUserId)) {
    return NextResponse.json({ error: "Bad request" }, { status: 400 });
  }

  const userId = await resolveTelegramUser(telegramUserId);
  if (!userId) return NextResponse.json({ error: "Not linked" }, { status: 404 });
  return NextResponse.json({ userId });
}

export const dynamic = "force-dynamic";
