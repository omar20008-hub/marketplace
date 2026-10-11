import "server-only";
import { timingSafeEqual } from "node:crypto";
import { env } from "@/lib/env";
import { hit } from "@/lib/rate-limit";
import { redeemTelegramCode, resolveTelegramUser } from "./channel-links";
import { answerMessage } from "./orchestrator/assistant";

/**
 * The Telegram bot's side of the Orchestrator: what the n8n "Telegram gateway"
 * workflow did, now in the platform. A message from a linked chat is answered as
 * that person; "/link <code>" links a chat; anything else from an unlinked chat
 * gets the instruction to link first.
 *
 * Telegram gets its 200 at once and the reply is sent afterwards (see the route),
 * because an answer can take longer than Telegram waits.
 */

export type TelegramUpdate = {
  update_id?: number;
  message?: {
    text?: string;
    chat: { id: number };
    from?: { id: number };
  };
};

export type TelegramDeps = {
  answer: (input: { userId: string; chatInput: string }) => Promise<string>;
  send: (chatId: number, text: string) => Promise<void>;
};

const LINKED = "تم ربط حسابك في المنصة. أرسل رسالتك هنا وسيردّ عليك المساعد.";
const NOT_LINKED =
  "حسابك غير مربوط بالمنصة. افتح صفحة الحسابات في المنصة واطلب رمز الربط، ثم أرسل هنا: /link <الرمز>";
const FAILED_ANSWER = "تعذّر الحصول على رد الآن. حاول مرة أخرى.";
const MAX_TELEGRAM_TEXT = 4000;

/** Guesses per Telegram account, the same budget the link endpoint used. */
const LINK_ATTEMPTS = { limit: 10, windowMs: 10 * 60_000 };

export function telegramRequestAuthorised(request: Request): boolean {
  const expected = env.telegram.webhookSecret;
  if (!expected) return false;
  const given = request.headers.get("x-telegram-bot-api-secret-token") ?? "";
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

export async function sendTelegramMessage(chatId: number, text: string): Promise<void> {
  const token = env.telegram.botToken;
  if (!token) {
    console.error("Telegram reply not sent: TELEGRAM_BOT_TOKEN is not set");
    return;
  }
  const response = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, text: text.slice(0, MAX_TELEGRAM_TEXT) }),
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) {
    console.error(`Telegram sendMessage answered ${response.status}`);
  }
}

const defaultDeps: TelegramDeps = {
  answer: (input) => answerMessage(input),
  send: sendTelegramMessage,
};

export async function handleTelegramUpdate(
  update: TelegramUpdate,
  deps: TelegramDeps = defaultDeps,
): Promise<void> {
  const message = update.message;
  if (!message?.text || !message.from) return;

  const chatId = message.chat.id;
  const telegramUserId = String(message.from.id);
  const text = message.text.trim();

  if (text.startsWith("/link ")) {
    const code = text.slice("/link ".length).trim().split(/\s+/)[0] ?? "";
    const limit = hit(`telegram-link:${telegramUserId}`, LINK_ATTEMPTS);
    if (!limit.ok) {
      await deps.send(chatId, "تعذّر الربط (rate_limited). حاول بعد قليل.");
      return;
    }
    const result = await redeemTelegramCode({ code, externalId: telegramUserId });
    await deps.send(
      chatId,
      result.ok
        ? LINKED
        : `تعذّر الربط (${result.reason}). أنشئ رمزاً جديداً من صفحة الحسابات وحاول مرة أخرى.`,
    );
    return;
  }

  const userId = await resolveTelegramUser(telegramUserId);
  if (!userId) {
    await deps.send(chatId, NOT_LINKED);
    return;
  }

  const output = await deps.answer({ userId, chatInput: text });
  await deps.send(chatId, output || FAILED_ANSWER);
}
