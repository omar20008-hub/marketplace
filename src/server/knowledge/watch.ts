import "server-only";
import { randomBytes, randomUUID } from "node:crypto";
import { prisma } from "@/lib/db";
import { env } from "@/lib/env";
import { GoogleAuthError } from "@/lib/google-oauth";
import { getStartPageToken, stopChannel, watchChanges } from "@/lib/drive";
import { getGoogleAccessToken } from "@/server/google-account";

/**
 * Drive push notifications: instead of polling every folder, Google POSTs to us
 * when an account's change feed moves.
 *
 * A channel is per source and expires — Drive decides when — so the lifecycle is
 * the whole job: create one, renew it before it lapses, and never depend on it.
 * The periodic re-listing in worker.ts is the safety net that makes a missed or
 * expired channel cost minutes-to-hours of freshness, not correctness.
 */

const ASK_FOR_MS = 7 * 86_400_000;
export const RENEW_BEFORE_MS = 3 * 3_600_000;

/** Where Google should call. Drive refuses anything but https, so a laptop gets none and falls back to polling. */
export function webhookAddress(): string | null {
  if (!env.google.redirectUri) return null;
  const origin = new URL(env.google.redirectUri).origin;
  return origin.startsWith("https://") ? `${origin}/api/knowledge/drive-webhook` : null;
}

/**
 * Makes sure this source has a change-feed cursor and, where a webhook address
 * exists, a channel with time left on it. The cursor is taken before anything is
 * listed, so a change made while the first listing runs is still seen.
 */
export async function ensureWatch(sourceId: string, token: string, { force = false } = {}) {
  let source = await prisma.knowledgeSource.findUnique({ where: { id: sourceId } });
  if (!source) return;

  if (!source.changesToken) {
    source = await prisma.knowledgeSource.update({
      where: { id: source.id },
      data: { changesToken: await getStartPageToken(token) },
    });
  }

  const address = webhookAddress();
  if (!address) return;
  const fresh =
    source.channelId &&
    source.channelExpiry &&
    source.channelExpiry.getTime() - Date.now() > RENEW_BEFORE_MS;
  if (fresh && !force) return;

  const channelId = randomUUID();
  const secret = randomBytes(24).toString("hex");
  const granted = await watchChanges(token, {
    pageToken: source.changesToken!,
    channelId,
    address,
    secret,
    expiresAt: new Date(Date.now() + ASK_FOR_MS),
  });

  await prisma.knowledgeSource.update({
    where: { id: source.id },
    data: {
      channelId,
      channelResourceId: granted.resourceId,
      channelToken: secret,
      channelExpiry: granted.expiresAt,
    },
  });

  // The new one is in place, so the old one can go. If stopping fails it simply
  // runs out; its notifications find no source and are ignored.
  if (source.channelId && source.channelResourceId) {
    await stopChannel(token, source.channelId, source.channelResourceId).catch(() => {});
  }
}

/** For when a source is removed: stop being called about it. Best effort. */
export async function stopWatch(sourceId: string) {
  const source = await prisma.knowledgeSource.findUnique({ where: { id: sourceId } });
  if (!source?.channelId || !source.channelResourceId) return;
  try {
    const token = await getGoogleAccessToken(source.accountId);
    await stopChannel(token, source.channelId, source.channelResourceId);
  } catch {
    // Expires on its own.
  }
  await prisma.knowledgeSource.update({
    where: { id: source.id },
    data: { channelId: null, channelResourceId: null, channelToken: null, channelExpiry: null },
  });
}

let lastRenewal = 0;
const RENEW_EVERY_MS = 5 * 60_000;

/**
 * Renews channels close to expiry, and creates one for a source that has none
 * (the webhook address was configured after the source was). Throttled, so a
 * worker looping every few seconds does not ask Google every few seconds.
 */
export async function renewWatches({ force = false } = {}): Promise<{ renewed: number; failed: number }> {
  const summary = { renewed: 0, failed: 0 };
  if (!webhookAddress()) return summary;
  if (!force && Date.now() - lastRenewal < RENEW_EVERY_MS) return summary;
  lastRenewal = Date.now();

  const due = await prisma.knowledgeSource.findMany({
    where: {
      status: "ACTIVE",
      OR: [
        { channelId: null },
        { channelExpiry: { lt: new Date(Date.now() + RENEW_BEFORE_MS) } },
      ],
    },
    select: { id: true, accountId: true },
    take: 100,
  });

  for (const source of due) {
    try {
      await ensureWatch(source.id, await getGoogleAccessToken(source.accountId));
      summary.renewed++;
    } catch (error) {
      if (!(error instanceof GoogleAuthError)) summary.failed++;
    }
  }
  return summary;
}
