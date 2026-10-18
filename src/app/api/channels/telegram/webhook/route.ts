import { NextResponse, after } from "next/server";
import {
  handleTelegramUpdate,
  telegramRequestAuthorised,
  type TelegramUpdate,
} from "@/server/telegram-gateway";

/**
 * Telegram's update receiver for the bot. Telegram sends every message here once
 * setWebhook points at this route with the same secret_token. The answer is sent
 * after the 200, so a slow model never makes Telegram retry the same message.
 */
export async function POST(request: Request) {
  if (!telegramRequestAuthorised(request)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  let update: TelegramUpdate;
  try {
    update = (await request.json()) as TelegramUpdate;
  } catch {
    return NextResponse.json({ error: "Bad request" }, { status: 400 });
  }

  after(async () => {
    try {
      await handleTelegramUpdate(update);
    } catch (error) {
      console.error("Telegram update failed", error instanceof Error ? error.name : "error");
    }
  });

  return NextResponse.json({ ok: true });
}

export const dynamic = "force-dynamic";
