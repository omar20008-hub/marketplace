"use server";

import { revalidatePath } from "next/cache";
import { requireUser } from "@/lib/auth";
import { hit } from "@/lib/rate-limit";
import { issueTelegramCode, unlinkTelegram } from "./channel-links";

/**
 * The accounts page's Telegram card. Only the signed-in person can ask for a
 * code, and the code comes back to that person alone.
 */

export type TelegramCodeState = { code?: string; expiresAt?: string; error?: string };

export async function startTelegramLink(): Promise<TelegramCodeState> {
  const user = await requireUser();
  const limit = hit(`telegram-code:${user.id}`, { limit: 5, windowMs: 10 * 60_000 });
  if (!limit.ok) {
    return { error: `Too many codes. Try again in ${Math.ceil(limit.retryAfterSeconds / 60)} min.` };
  }
  const { code, expiresAt } = await issueTelegramCode(user.id);
  return { code, expiresAt: expiresAt.toISOString() };
}

export async function removeTelegramLink(): Promise<void> {
  const user = await requireUser();
  await unlinkTelegram(user.id);
  revalidatePath("/accounts");
}
