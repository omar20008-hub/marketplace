import "server-only";
import { prisma } from "@/lib/db";
import { processChanges } from "./changes";
import { recordTick } from "./heartbeat";
import { renewWatches } from "./watch";
import { giveUpOnFile, indexFile, syncSource } from "./indexer";
import { claim, complete, enqueue, fail, type Job } from "./queue";

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

export type RunSummary = { ran: number; failed: number; gaveUp: number };

export async function runKnowledgeJobs({ budgetMs = 50_000, maxJobs = 200 } = {}): Promise<RunSummary> {
  const deadline = Date.now() + budgetMs;
  const summary: RunSummary = { ran: 0, failed: 0, gaveUp: 0 };
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
      summary.failed++;
      if (await fail(job, message)) {
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
