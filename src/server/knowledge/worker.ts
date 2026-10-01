import "server-only";
import { prisma } from "@/lib/db";
import { knowledgeAvailable } from "./availability";
import { processChanges } from "./changes";
import { recordTick } from "./heartbeat";
import { renewWatches } from "./watch";
import { giveUpOnFile, indexFile, syncSource } from "./indexer";
import { classifyJobError, logName } from "./errors";
import { MAX_ATTEMPTS, claim, complete, enqueue, fail, retryDelaySeconds, type Job } from "./queue";

/**
 * Runs queued jobs until the queue is empty or the time budget is spent. Called
 * by the worker process in a loop, and by /api/knowledge/tick for a deployment
 * with no separate worker; several callers at once are safe.
 */

/** Until push notifications (or as their safety net), every source is re-listed this often. */
export const RECONCILE_HOURS = 6;

export async function enqueueDueSyncs(now = new Date()): Promise<number> {
  const cutoff = new Date(now.getTime() - RECONCILE_HOURS * 3_600_000);
  const due = await prisma.knowledgeSource.findMany({
    where: {
      status: "ACTIVE",
      OR: [{ lastSyncedAt: null }, { lastSyncedAt: { lt: cutoff } }],
    },
    select: { id: true },
    take: 500,
  });
  for (const { id } of due) await enqueue("SYNC_SOURCE", id);
  return due.length;
}

async function run(job: Job) {
  if (job.kind === "SYNC_SOURCE") return syncSource(job.targetId);
  if (job.kind === "SYNC_CHANGES") return processChanges(job.targetId);
  return indexFile(job.targetId);
}

export type RunSummary = {
  ran: number;
  failed: number;
  gaveUp: number;
  /** Failures by kind (see errors.ts), e.g. { embeddings_rate_limit: 2 }. */
  failedByType: Record<string, number>;
};

/**
 * Two lines per failed job, so a log says what failed and why without anyone
 * querying a table: the kind of error with the attempt it was and when it will be
 * tried again, then the file (or folder) on its own line. The kind only — never
 * the error's own message.
 */
async function logFailure(job: Job, type: string, gaveUp: boolean, log: (line: string) => void) {
  try {
    const next = gaveUp ? "gave up" : `retry_in=${retryDelaySeconds(job.attempts)}s`;
    log(`knowledge job failed: kind=${job.kind} type=${type} attempt=${job.attempts}/${MAX_ATTEMPTS} ${next}`);
    if (job.kind === "INDEX_FILE") {
      const file = await prisma.knowledgeFile.findUnique({ where: { id: job.targetId }, select: { name: true } });
      if (file) log(`knowledge job file: ${logName(file.name)}`);
    } else {
      const source = await prisma.knowledgeSource.findUnique({ where: { id: job.targetId }, select: { folderName: true } });
      if (source) log(`knowledge job folder: ${logName(source.folderName)}`);
    }
  } catch {
    // Reporting a failure must never become one.
  }
}

export async function runKnowledgeJobs({
  budgetMs = 50_000,
  maxJobs = 200,
  log = console.log,
}: { budgetMs?: number; maxJobs?: number; log?: (line: string) => void } = {}): Promise<RunSummary> {
  const deadline = Date.now() + budgetMs;
  const summary: RunSummary = { ran: 0, failed: 0, gaveUp: 0, failedByType: {} };
  await recordTick();
  await renewWatches().catch(() => {});

  while (summary.ran + summary.failed < maxJobs && Date.now() < deadline) {
    const job = await claim();
    if (!job) break;
    try {
      const outcome = await run(job);
      if (outcome.again) await enqueue(job.kind, job.targetId);
      await complete(job);
      summary.ran++;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const type = classifyJobError(error);
      summary.failed++;
      summary.failedByType[type] = (summary.failedByType[type] ?? 0) + 1;
      const gaveUp = await fail(job, message);
      await logFailure(job, type, gaveUp, log);
      if (gaveUp) {
        summary.gaveUp++;
        if (job.kind === "INDEX_FILE") await giveUpOnFile(job.targetId, message);
        else {
          await prisma.knowledgeSource.updateMany({
            where: { id: job.targetId },
            data: { lastError: `Sync failed: ${message.slice(0, 200)}` },
          });
        }
      }
    }
  }
  return summary;
}

export type TickSummary = RunSummary & { available: boolean; queued: number };

/**
 * One whole pass, the same whether an outside clock calls the tick endpoint or
 * the in-process scheduler calls this directly: note that the clock is running,
 * queue the folders that are due, drain the queue for a while.
 */
export async function tickKnowledge({ budgetMs }: { budgetMs?: number } = {}): Promise<TickSummary> {
  // The clock is running, whether or not there is anything to do with it.
  await recordTick();
  if (!(await knowledgeAvailable())) {
    return { available: false, queued: 0, ran: 0, failed: 0, gaveUp: 0, failedByType: {} };
  }
  const queued = await enqueueDueSyncs();
  return { available: true, queued, ...(await runKnowledgeJobs(budgetMs ? { budgetMs } : {})) };
}
