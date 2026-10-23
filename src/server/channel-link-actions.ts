"use server";

import { revalidatePath } from "next/cache";
import { requireUser } from "@/lib/auth";
import { hit } from "@/lib/rate-limit";
import { channelLinkFor, issueChannelCode, unlinkChannel, WHATSAPP, TELEGRAM } from "./channel-links";

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
  const { code, expiresAt } = await issueChannelCode(user.id, TELEGRAM);
  return { code, expiresAt: expiresAt.toISOString() };
}

export async function removeTelegramLink(): Promise<void> {
  const user = await requireUser();
  await unlinkChannel(user.id, TELEGRAM);
  revalidatePath("/accounts");
}

/** The WhatsApp card. Same proof as Telegram: a code the person sends from WhatsApp. */
export async function startWhatsappLink(): Promise<TelegramCodeState> {
  const user = await requireUser();
  const limit = hit(`whatsapp-code:${user.id}`, { limit: 5, windowMs: 10 * 60_000 });
  if (!limit.ok) {
    return { error: `Too many codes. Try again in ${Math.ceil(limit.retryAfterSeconds / 60)} min.` };
  }
  const { code, expiresAt } = await issueChannelCode(user.id, WHATSAPP);
  return { code, expiresAt: expiresAt.toISOString() };
}

/**
 * Whether the signed-in person's WhatsApp is linked yet. The welcome page asks
 * while they are away sending the code, so it can say when it went through.
 */
export async function whatsappLinked(): Promise<boolean> {
  const user = await requireUser();
  return (await channelLinkFor(user.id, WHATSAPP)) !== null;
}

export async function removeWhatsappLink(): Promise<void> {
  const user = await requireUser();
  await unlinkChannel(user.id, WHATSAPP);
  revalidatePath("/accounts");
}
