import "server-only";
import { prisma } from "@/lib/db";
import { env } from "@/lib/env";
import { tickKnowledge } from "./worker";

/**
 * The knowledge tick, run by the server itself.
 *
 * Indexing only happens when someone drains the queue. Needing an outside clock
 * for that — a cron, an n8n workflow — makes a core feature depend on a second
 * system nobody remembers to set up. So the server can do it: with
 * KNOWLEDGE_TICK_INTERVAL_SECONDS set (60 is right), the same pass the tick
 * endpoint runs is called straight from the process, no HTTP, no token.
 *
 * What keeps it safe:
 *  - Opt-in. Unset or 0 means off, and it never starts during `next build`, under
 *    the test runner, or in development unless asked (KNOWLEDGE_TICK_IN_DEV=true).
 *  - One pass at a time, in this process (the next one is scheduled when the last
 *    finishes) and across processes (a Postgres advisory lock: a second replica,
 *    or a pass that overran, finds it taken and skips).
 *  - A failure is logged, briefly and without anything that could be a secret, and
 *    the next pass runs anyway.
 *  - It never keeps the process alive, and never delays startup: register() starts
 *    the timer and returns.
 *
 * Needs a server that stays up. On a serverless host, use the tick endpoint.
 */

/** An arbitrary constant: the advisory lock every tick pass takes. */
const LOCK_KEY = 734_000_101;
/** Leave room under the interval, and under a request's own limit, for one pass. */
const PASS_BUDGET_MS = 45_000;
/** Hold-time ceiling for the lock's transaction; a pass is budgeted far below it. */
const LOCK_TX_TIMEOUT_MS = 300_000;
/** Let the server finish booting (and the database answer) before the first pass. */
const FIRST_PASS_DELAY_MS = 5_000;

export type LockResult<T> = { ran: true; value: T } | { ran: false };

/**
 * Runs `fn` only if no other pass anywhere holds the lock. The lock lives as long
 * as a transaction that does nothing else, so it is released the moment the pass
 * ends — or the connection dies — and can never be left behind.
 */
export async function withTickLock<T>(fn: () => Promise<T>): Promise<LockResult<T>> {
  return prisma.$transaction(
    async (tx) => {
      const [row] = await tx.$queryRaw<{ locked: boolean }[]>`
        SELECT pg_try_advisory_xact_lock(${LOCK_KEY}::bigint) AS locked`;
      if (!row?.locked) return { ran: false as const };
      return { ran: true as const, value: await fn() };
    },
    { timeout: LOCK_TX_TIMEOUT_MS, maxWait: 5_000 },
  );
}

/** One scheduled pass. Logs a line per pass, so "is it running" is answered by the log. */
export async function runScheduledPass(
  tick: typeof tickKnowledge = tickKnowledge,
  log: (line: string) => void = console.log,
): Promise<void> {
  const result = await withTickLock(() => tick({ budgetMs: PASS_BUDGET_MS }));
  if (!result.ran) {
    log("knowledge tick skipped: another pass holds the lock");
  } else if (!result.value.available) {
    log("knowledge tick: pgvector is not available on this database");
  } else {
    const { queued, ran, failed, gaveUp } = result.value;
    log(`knowledge tick ok: queued=${queued} ran=${ran} failed=${failed} gaveUp=${gaveUp}`);
  }
}

/** What an error may say in a log: its kind, never its message (which can quote a query or a value). */
export function describeError(error: unknown): string {
  if (error instanceof Error) {
    const code = (error as { code?: unknown }).code;
    return typeof code === "string" ? `${error.name} ${code}` : error.name;
  }
  return "unknown error";
}

export type Scheduler = { stop(): void };

/**
 * Calls `pass` forever: first after `firstDelayMs`, then `intervalMs` after each
 * one *started*, so a slow pass shortens the wait instead of stretching the cycle.
 * Passes never overlap, and one that throws changes nothing about the next.
 */
export function createScheduler({
  intervalMs,
  firstDelayMs = intervalMs,
  pass,
  onError,
  now = Date.now,
}: {
  intervalMs: number;
  firstDelayMs?: number;
  pass: () => Promise<void>;
  onError: (error: unknown) => void;
  now?: () => number;
}): Scheduler {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let stopped = false;

  const schedule = (delay: number) => {
    if (stopped) return;
    timer = setTimeout(run, delay);
    // A pending timer must not be what keeps a shutting-down server alive.
    timer.unref?.();
  };

  async function run() {
    const started = now();
    try {
      await pass();
    } catch (error) {
      try {
        onError(error);
      } catch {
        // Reporting a failure must not become the failure.
      }
    }
    schedule(Math.max(0, intervalMs - (now() - started)));
  }

  schedule(firstDelayMs);
  return {
    stop() {
      stopped = true;
      if (timer) clearTimeout(timer);
    },
  };
}

/** Whether this process should run the scheduler at all. Pure, so it can be tested without booting one. */
export function shouldRunScheduler({
  intervalSeconds,
  nodeEnv,
  phase,
  inDev,
}: {
  intervalSeconds: number;
  nodeEnv: string | undefined;
  phase: string | undefined;
  inDev: boolean;
}): boolean {
  if (intervalSeconds <= 0) return false;
  if (phase === "phase-production-build") return false;
  if (nodeEnv === "test") return false;
  if (nodeEnv !== "production") return inDev;
  return true;
}

const globalForScheduler = globalThis as unknown as { __knowledgeScheduler?: Scheduler };

/**
 * Called once from instrumentation.ts. Idempotent: development re-evaluates
 * modules on every edit, and two timers would be two passes.
 */
export function startKnowledgeScheduler(): Scheduler | null {
  const intervalSeconds = env.knowledgeTickIntervalSeconds;
  if (
    !shouldRunScheduler({
      intervalSeconds,
      nodeEnv: process.env.NODE_ENV,
      phase: process.env.NEXT_PHASE,
      inDev: process.env.KNOWLEDGE_TICK_IN_DEV === "true",
    })
  ) {
    return null;
  }
  if (globalForScheduler.__knowledgeScheduler) return globalForScheduler.__knowledgeScheduler;

  console.log(`Knowledge scheduler started: a tick every ${intervalSeconds}s`);
  const scheduler = createScheduler({
    intervalMs: intervalSeconds * 1000,
    firstDelayMs: FIRST_PASS_DELAY_MS,
    pass: () => runScheduledPass(),
    onError: (error) => console.error(`Knowledge tick failed: ${describeError(error)}`),
  });
  globalForScheduler.__knowledgeScheduler = scheduler;
  return scheduler;
}
