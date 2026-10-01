import "server-only";
import { prisma } from "@/lib/db";

/**
 * The job queue. Postgres is the queue: a row per pending job, claimed with
 * FOR UPDATE SKIP LOCKED under a lease. A worker that dies mid-job lets the lease
 * lapse and the job is picked up again; two workers never get the same one.
 */

export type JobKind = "SYNC_SOURCE" | "SYNC_CHANGES" | "INDEX_FILE";
export type Job = { id: string; kind: JobKind; targetId: string; attempts: number };

export const MAX_ATTEMPTS = 5;
/**
 * A rate limit is not the file's fault and passes with time, so it gets more, and
 * longer, chances than an ordinary failure: 12 tries spread over many hours rather
 * than 5 inside an hour (which is shorter than the quota windows it is waiting out).
 */
export const MAX_RATE_LIMIT_ATTEMPTS = 12;
const MAX_RATE_LIMIT_DELAY_SECONDS = 3600;

export type RetryInfo = { rateLimited?: boolean; retryAfterSeconds?: number };

export function maxAttemptsFor(info: RetryInfo = {}): number {
  return info.rateLimited ? MAX_RATE_LIMIT_ATTEMPTS : MAX_ATTEMPTS;
}
const LEASE_MINUTES = 10;

/**
 * One job per (kind, target). Asking again while it waits changes nothing; asking
 * while it runs marks it to go round once more, so a change that lands mid-run is
 * never lost to the run that started before it.
 */
export async function enqueue(kind: JobKind, targetId: string, delaySeconds = 0) {
  const dedupeKey = `${kind}:${targetId}`;
  await prisma.$executeRaw`
    INSERT INTO "KnowledgeJob" (id, kind, "targetId", "dedupeKey", "runAfter")
    VALUES (gen_random_uuid()::text, ${kind}::"KnowledgeJobKind", ${targetId}, ${dedupeKey},
            now() + make_interval(secs => ${delaySeconds}))
    ON CONFLICT ("dedupeKey") DO UPDATE
      SET rerun = ("KnowledgeJob"."leasedUntil" IS NOT NULL AND "KnowledgeJob"."leasedUntil" > now())`;
}

export async function claim(): Promise<Job | null> {
  const rows = await prisma.$queryRaw<Job[]>`
    UPDATE "KnowledgeJob"
    SET "leasedUntil" = now() + make_interval(mins => ${LEASE_MINUTES}),
        attempts = attempts + 1
    WHERE id = (
      SELECT id FROM "KnowledgeJob"
      WHERE "runAfter" <= now() AND ("leasedUntil" IS NULL OR "leasedUntil" < now())
      ORDER BY "runAfter"
      LIMIT 1
      FOR UPDATE SKIP LOCKED
    )
    RETURNING id, kind::text AS kind, "targetId", attempts`;
  return rows[0] ?? null;
}

/** Done — or, if it was asked for again meanwhile, back in line for another pass. */
export async function complete(job: Job) {
  await prisma.$executeRaw`
    WITH again AS (
      UPDATE "KnowledgeJob"
      SET rerun = false, attempts = 0, "leasedUntil" = NULL, "runAfter" = now()
      WHERE id = ${job.id} AND rerun
      RETURNING id
    )
    DELETE FROM "KnowledgeJob" WHERE id = ${job.id} AND NOT EXISTS (SELECT 1 FROM again)`;
}

/** How long a job that has failed `attempts` times waits before its next try: 30s, 2m, 8m, 32m (or, for a rate limit, 1m doubling to an hour). */
export function retryDelaySeconds(attempts: number, info: RetryInfo = {}): number {
  if (!info.rateLimited) return 30 * 4 ** (attempts - 1);
  // 1m, 2m, 4m, ... up to an hour, never sooner than the API asked for.
  const backoff = Math.min(MAX_RATE_LIMIT_DELAY_SECONDS, 60 * 2 ** (attempts - 1));
  return Math.min(MAX_RATE_LIMIT_DELAY_SECONDS, Math.max(backoff, info.retryAfterSeconds ?? 0));
}

/** Failed: back off and retry, or drop it once it has had its chances. Returns true when it gave up. */
export async function fail(job: Job, message: string, info: RetryInfo = {}): Promise<boolean> {
  if (job.attempts >= maxAttemptsFor(info)) {
    await prisma.knowledgeJob.deleteMany({ where: { id: job.id } });
    return true;
  }
  const delay = retryDelaySeconds(job.attempts, info);
  await prisma.$executeRaw`
    UPDATE "KnowledgeJob"
    SET "leasedUntil" = NULL, "lastError" = ${message.slice(0, 500)},
        "runAfter" = now() + make_interval(secs => ${delay})
    WHERE id = ${job.id}`;
  return false;
}
