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

/** Failed: back off and retry, or drop it once it has had its chances. Returns true when it gave up. */
export async function fail(job: Job, message: string): Promise<boolean> {
  if (job.attempts >= MAX_ATTEMPTS) {
    await prisma.knowledgeJob.deleteMany({ where: { id: job.id } });
    return true;
  }
  const delay = 30 * 4 ** (job.attempts - 1); // 30s, 2m, 8m, 32m
  await prisma.$executeRaw`
    UPDATE "KnowledgeJob"
    SET "leasedUntil" = NULL, "lastError" = ${message.slice(0, 500)},
        "runAfter" = now() + make_interval(secs => ${delay})
    WHERE id = ${job.id}`;
  return false;
}
