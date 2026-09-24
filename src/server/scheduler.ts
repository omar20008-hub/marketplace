import { prisma } from "@/lib/db";
import { nextRun } from "@/lib/cron";
import { executeRun } from "./run-engine";
import type { Run } from "@/generated/prisma";

/**
 * The tick: run whatever is due.
 *
 * Nothing in this file decides whether a run is allowed — it hands every firing
 * to executeRun(), which is the same path the Run button and the composer take.
 * A schedule therefore hits the same readiness check, the same plan limit and
 * the same argument validator, and a scheduled run that is refused is refused
 * for a reason the user can already read on the screen.
 *
 * Not a "use server" module, and it must not become one: a tick takes no
 * session, so every export here would be an unauthenticated Server Action. The
 * only ways in are the token-protected route and the runner script, both of
 * which say who is allowed to call them.
 *
 * Two behaviours worth knowing:
 *
 *  - **A missed window fires once, not once per miss.** The next due time is
 *    computed from now rather than from the time that was missed, so a daily
 *    schedule after a week of downtime runs once and then resumes. Catching up
 *    seven times would be a surprise nobody asked for, and on an hourly
 *    schedule it would be a stampede.
 *
 *  - **A schedule with no next time is set, not fired.** A row whose nextRunAt
 *    is null has never been scheduled; treating null as "overdue since the
 *    epoch" would make every newly seeded schedule fire the moment the first
 *    tick ran.
 */

export type ScheduleOutcome = {
  scheduleId: string;
  label: string;
  /** What the tick did, for the caller's log. */
  action: "ran" | "initialised" | "claimed-elsewhere" | "disabled" | "skipped";
  status?: string;
  runId?: string;
};

export type TickSummary = {
  checked: number;
  ran: number;
  outcomes: ScheduleOutcome[];
};

/** How a finished run reads in the schedules table. */
export function statusLabel(run: Run | null): string {
  if (!run) return "Could not start";

  switch (run.result) {
    case "SUCCESS":
      return "Succeeded";
    case "PARTIAL":
      return "Partly done";
    case "INCOMPLETE":
      // The saved inputs no longer satisfy the product — it has probably asked
      // for a new field since the schedule was made.
      return "Needs input";
    case "BLOCKED":
      return run.errorType ? `Blocked · ${run.errorType}` : "Blocked";
    case "DENIED":
      return "Denied";
    case "STOPPED":
      return "Stopped";
    default:
      return "Failed";
  }
}

function argsOf(schedule: { args: unknown }): Record<string, unknown> {
  return schedule.args && typeof schedule.args === "object" && !Array.isArray(schedule.args)
    ? (schedule.args as Record<string, unknown>)
    : {};
}

/**
 * Runs every schedule that is due, and returns what happened to each.
 *
 * `limit` bounds one tick so a large backlog cannot hold the request open
 * indefinitely; the next tick picks up the rest.
 */
export async function runDueSchedules({
  now = new Date(),
  limit = 50,
}: { now?: Date; limit?: number } = {}): Promise<TickSummary> {
  const due = await prisma.schedule.findMany({
    where: {
      enabled: true,
      OR: [{ nextRunAt: null }, { nextRunAt: { lte: now } }],
    },
    orderBy: { nextRunAt: { sort: "asc", nulls: "first" } },
    take: limit,
  });

  const outcomes: ScheduleOutcome[] = [];

  for (const schedule of due) {
    let following: Date;
    try {
      following = nextRun(schedule.cron, now);
    } catch (error) {
      // An expression that cannot be read can never fire, so leaving it enabled
      // would mean re-reading and re-failing on every tick forever. Turn it off
      // and say why, where the owner will see it.
      await prisma.schedule.update({
        where: { id: schedule.id },
        data: {
          enabled: false,
          lastStatus: error instanceof Error ? error.message : "Unreadable schedule",
        },
      });
      outcomes.push({
        scheduleId: schedule.id,
        label: schedule.label,
        action: "disabled",
        status: "Unreadable schedule",
      });
      continue;
    }

    // A row that has never been scheduled gets its first time and waits for it.
    if (schedule.nextRunAt === null) {
      await prisma.schedule.update({
        where: { id: schedule.id },
        data: { nextRunAt: following },
      });
      outcomes.push({
        scheduleId: schedule.id,
        label: schedule.label,
        action: "initialised",
      });
      continue;
    }

    // Claim it by moving nextRunAt on, but only if it still holds the value
    // this tick read. Two ticks overlapping — a slow run and a cron that fires
    // again underneath it — then means one of them claims and the other moves
    // on, rather than both running the same schedule.
    const claim = await prisma.schedule.updateMany({
      where: { id: schedule.id, nextRunAt: schedule.nextRunAt, enabled: true },
      data: { nextRunAt: following },
    });
    if (claim.count === 0) {
      outcomes.push({
        scheduleId: schedule.id,
        label: schedule.label,
        action: "claimed-elsewhere",
      });
      continue;
    }

    // The owner comes from the schedule row, never from the caller. The tick is
    // unauthenticated by nature, so this is the only thing standing between a
    // scheduled run and someone else's workspace.
    const user = await prisma.user.findUnique({
      where: { id: schedule.userId },
      include: { plan: true },
    });

    if (!user) {
      await prisma.schedule.update({
        where: { id: schedule.id },
        data: { enabled: false, lastStatus: "Owner no longer exists" },
      });
      outcomes.push({
        scheduleId: schedule.id,
        label: schedule.label,
        action: "disabled",
        status: "Owner no longer exists",
      });
      continue;
    }

    let run: Run | null = null;
    let status: string;
    try {
      run = await executeRun({
        user,
        installationId: schedule.installationId,
        args: argsOf(schedule),
      });
      status = statusLabel(run);
    } catch (error) {
      // A thrown dispatcher — n8n unreachable, say — must not take the whole
      // tick down with it and leave the remaining schedules unrun.
      status = error instanceof Error ? `Failed · ${error.message}` : "Failed";
    }

    await prisma.schedule.update({
      where: { id: schedule.id },
      data: { lastRunAt: new Date(), lastStatus: status, lastRunId: run?.id ?? null },
    });

    outcomes.push({
      scheduleId: schedule.id,
      label: schedule.label,
      action: "ran",
      status,
      runId: run?.id,
    });
  }

  return {
    checked: due.length,
    ran: outcomes.filter((outcome) => outcome.action === "ran").length,
    outcomes,
  };
}
