import "server-only";
import { prisma } from "@/lib/db";

/**
 * Whether anything is actually draining the knowledge queue.
 *
 * Indexing runs only when something calls POST /api/knowledge/tick (or the worker
 * process runs). If nothing does, jobs wait forever and the Files page looks the
 * same as when work is merely slow: "Syncing", zero ready, no explanation. So
 * every drain pass leaves a timestamp, and the page compares the two.
 *
 * All the arithmetic is done in the database against its own clock. The queue
 * writes its times with the database's now() (see queue.ts), and mixing a JS
 * Date into that is how an off-by-the-timezone stall alarm gets built.
 */

export const TICK = "knowledge-tick";
export const STALL_AFTER_SECONDS = 120;
/** A busy worker passes every few seconds; one write that often says nothing new. */
const WRITE_EVERY_SECONDS = 15;

/** A drain pass ran just now. Never throws: bookkeeping must not break the work it records. */
export async function recordTick(): Promise<void> {
  try {
    await prisma.$executeRaw`
      INSERT INTO "Heartbeat" (name, at) VALUES (${TICK}, now())
      ON CONFLICT (name) DO UPDATE SET at = now()
      WHERE "Heartbeat".at < now() - make_interval(secs => ${WRITE_EVERY_SECONDS})`;
  } catch (error) {
    console.error(`Could not record the knowledge tick: ${error instanceof Error ? error.name : "unknown"}`);
  }
}

export type QueueHealth = {
  /** Seconds since the last drain pass, or null if there has never been one. */
  lastTickAgeSeconds: number | null;
  /** Jobs that were due, are not being worked on, and have waited past the threshold. */
  waitingTooLong: number;
};

/**
 * `sourceIds` narrows it to one user's folders (their sync jobs, and the
 * indexing jobs of their files); omit it to ask about the whole queue.
 */
export async function queueHealth(sourceIds?: string[]): Promise<QueueHealth> {
  const scoped = sourceIds !== undefined;
  const ids = sourceIds ?? [];
  const [row] = await prisma.$queryRaw<{ age: number | null; waiting: bigint }[]>`
    SELECT
      (SELECT EXTRACT(EPOCH FROM (now() - at))::float FROM "Heartbeat" WHERE name = ${TICK}) AS age,
      (SELECT count(*) FROM "KnowledgeJob" j
        WHERE j."runAfter" < now() - make_interval(secs => ${STALL_AFTER_SECONDS})
          AND (j."leasedUntil" IS NULL OR j."leasedUntil" < now())
          AND (${!scoped}::boolean
               OR j."targetId" = ANY(${ids}::text[])
               OR j."targetId" IN (SELECT id FROM "KnowledgeFile" WHERE "sourceId" = ANY(${ids}::text[])))
      ) AS waiting`;
  return { lastTickAgeSeconds: row.age, waitingTooLong: Number(row.waiting) };
}

/**
 * Work is waiting and nothing has come to take it. Both halves matter: jobs
 * waiting while ticks arrive means a backlog, which the normal progress display
 * already shows; no ticks and nothing waiting means an idle system, which is fine.
 */
export function isStalled(health: QueueHealth): boolean {
  if (health.waitingTooLong === 0) return false;
  return health.lastTickAgeSeconds === null || health.lastTickAgeSeconds > STALL_AFTER_SECONDS;
}

export async function processingStalled(sourceIds: string[]): Promise<boolean> {
  if (sourceIds.length === 0) return false;
  return isStalled(await queueHealth(sourceIds));
}
