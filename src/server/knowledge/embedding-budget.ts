import "server-only";
import { prisma } from "@/lib/db";
import { env } from "@/lib/env";

/**
 * Our own count of what indexing has embedded today, so a quota that is nearly
 * spent is waited out on purpose instead of run into. Counted from the files
 * indexed since the provider's day began (chunks written; a failed attempt and a
 * search's one query are not counted, which is why the limit is set under the real
 * quota).
 */

const QUOTA_ZONE = "America/Los_Angeles";

function zoneParts(date: Date) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: QUOTA_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(date);
  const get = (type: string) => Number(parts.find((p) => p.type === type)?.value);
  return { y: get("year"), m: get("month"), d: get("day"), h: get("hour"), min: get("minute") };
}

/** The instant the current quota day began: midnight Pacific Time (-7h or -8h from UTC). */
export function quotaDayStart(now = new Date()): Date {
  const { y, m, d } = zoneParts(now);
  for (const offsetHours of [7, 8]) {
    const candidate = new Date(Date.UTC(y, m - 1, d, offsetHours));
    const p = zoneParts(candidate);
    if (p.d === d && p.h === 0 && p.min === 0) return candidate;
  }
  return new Date(Date.UTC(y, m - 1, d, 8));
}

export type EmbeddingRoom = {
  /** The configured limit; 0 means none. */
  limit: number;
  used: number;
  remaining: number;
  /** Seconds until the quota day turns over. */
  secondsToReset: number;
};

export async function embeddingRoom(now = new Date()): Promise<EmbeddingRoom> {
  const limit = env.embeddings.dailyLimit;
  const start = quotaDayStart(now);
  const secondsToReset = Math.max(60, Math.ceil((start.getTime() + 86_400_000 - now.getTime()) / 1000));
  if (!limit) return { limit: 0, used: 0, remaining: Number.POSITIVE_INFINITY, secondsToReset };
  const sum = await prisma.knowledgeFile.aggregate({
    where: { indexedAt: { gte: start } },
    _sum: { chunkCount: true },
  });
  const used = sum._sum.chunkCount ?? 0;
  return { limit, used, remaining: Math.max(0, limit - used), secondsToReset };
}

/**
 * Whether `needed` texts may be embedded now. A file bigger than the whole day's
 * allowance is let through on a fresh day (it cannot ever fit, and the provider's
 * own limit then decides) rather than waiting forever.
 */
export function fits(room: EmbeddingRoom, needed: number): boolean {
  if (!room.limit) return true;
  if (needed <= room.remaining) return true;
  return needed > room.limit && room.used === 0;
}

export const WAITING_FOR_NEW_DAY =
  "Today's embedding allowance is used up. Indexing continues automatically after it resets (midnight Pacific Time).";
