import "server-only";
import { createHash, randomInt } from "node:crypto";
import { prisma } from "@/lib/db";

/**
 * Linking a person's chat-channel account to their platform account.
 *
 * The person asks for a code here, then sends "/link <code>" to the bot. n8n
 * relays that message to the platform, which checks the code and records the
 * channel id against the user who asked. The platform never trusts a channel
 * id typed into a form: only proof that the person controls the chat (they
 * could send the code from it) links it.
 *
 * Codes are single-use and short-lived. Only their SHA-256 is stored.
 */

export const TELEGRAM = "telegram";
export const WHATSAPP = "whatsapp";

/** The chat channels a person can link. Each is proved the same way: a code sent from the chat. */
export type ChannelName = typeof TELEGRAM | typeof WHATSAPP;

const CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // no 0/O/1/I to avoid misreading
const CODE_LENGTH = 8;
const CODE_TTL_MS = 10 * 60 * 1000;

export function hashCode(code: string): string {
  return createHash("sha256").update(code.trim().toUpperCase()).digest("hex");
}

function newCode(): string {
  let out = "";
  for (let i = 0; i < CODE_LENGTH; i++) {
    out += CODE_ALPHABET[randomInt(CODE_ALPHABET.length)];
  }
  return out;
}

/** Creates a fresh code for this user and drops any earlier unused ones. */
export async function issueChannelCode(
  userId: string,
  channel: ChannelName,
  now: Date = new Date(),
): Promise<{ code: string; expiresAt: Date }> {
  const code = newCode();
  const expiresAt = new Date(now.getTime() + CODE_TTL_MS);
  await prisma.$transaction([
    prisma.channelLinkCode.deleteMany({
      where: { userId, channel, usedAt: null },
    }),
    prisma.channelLinkCode.create({
      data: { userId, channel, codeHash: hashCode(code), expiresAt },
    }),
  ]);
  return { code, expiresAt };
}

export function issueTelegramCode(userId: string, now: Date = new Date()) {
  return issueChannelCode(userId, TELEGRAM, now);
}

export type RedeemResult =
  | { ok: true; userId: string }
  | { ok: false; reason: "invalid" | "expired" | "used" | "taken" };

/**
 * Spends a code and links `externalId` (the Telegram user id) to the code's
 * owner. Refuses when that chat already belongs to a different platform user.
 * Replaces any Telegram account the owner had linked before.
 */
export async function redeemChannelCode(
  { code, externalId, channel }: { code: string; externalId: string; channel: ChannelName },
  now: Date = new Date(),
): Promise<RedeemResult> {
  const row = await prisma.channelLinkCode.findUnique({
    where: { codeHash: hashCode(code) },
  });
  if (!row || row.channel !== channel) return { ok: false, reason: "invalid" };
  if (row.usedAt) return { ok: false, reason: "used" };
  if (row.expiresAt <= now) return { ok: false, reason: "expired" };

  return prisma.$transaction(async (tx) => {
    const holder = await tx.channelLink.findUnique({
      where: { channel_externalId: { channel, externalId } },
    });
    if (holder && holder.userId !== row.userId) {
      return { ok: false, reason: "taken" } as const;
    }

    // Claim the code only if nobody else has spent it in the meantime.
    const claimed = await tx.channelLinkCode.updateMany({
      where: { id: row.id, usedAt: null },
      data: { usedAt: now },
    });
    if (claimed.count !== 1) return { ok: false, reason: "used" } as const;

    await tx.channelLink.upsert({
      where: { userId_channel: { userId: row.userId, channel } },
      create: { userId: row.userId, channel, externalId },
      update: { externalId, linkedAt: now },
    });
    await tx.auditLog.create({
      data: {
        actorId: row.userId,
        action: `channel.${channel}.linked`,
        subject: channel,
      },
    });
    return { ok: true, userId: row.userId } as const;
  });
}

/** What the accounts page may show. The channel id itself stays on the server. */
export async function channelLinkFor(userId: string, channel: ChannelName): Promise<{ linkedAt: Date } | null> {
  const row = await prisma.channelLink.findUnique({
    where: { userId_channel: { userId, channel } },
    select: { linkedAt: true },
  });
  return row;
}

export function telegramLinkFor(userId: string) {
  return channelLinkFor(userId, TELEGRAM);
}

export async function unlinkChannel(userId: string, channel: ChannelName): Promise<void> {
  await prisma.$transaction([
    prisma.channelLink.deleteMany({ where: { userId, channel } }),
    prisma.channelLinkCode.deleteMany({ where: { userId, channel } }),
    prisma.auditLog.create({
      data: {
        actorId: userId,
        action: `channel.${channel}.unlinked`,
        subject: channel,
      },
    }),
  ]);
}

export function unlinkTelegram(userId: string) {
  return unlinkChannel(userId, TELEGRAM);
}

/** Which platform user owns this chat account on the channel, or null if none does. */
export async function resolveChannelUser(channel: ChannelName, externalId: string): Promise<string | null> {
  const row = await prisma.channelLink.findUnique({
    where: { channel_externalId: { channel, externalId } },
    select: { userId: true },
  });
  return row?.userId ?? null;
}

export function redeemTelegramCode(
  { code, externalId }: { code: string; externalId: string },
  now: Date = new Date(),
) {
  return redeemChannelCode({ code, externalId, channel: TELEGRAM }, now);
}

export function resolveTelegramUser(externalId: string) {
  return resolveChannelUser(TELEGRAM, externalId);
}
