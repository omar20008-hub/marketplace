"use server";

import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/db";
import { requireUser } from "@/lib/auth";
import { nextRun } from "@/lib/cron";
import {
  cadenceLabel,
  cronFor,
  isCadence,
  isTimeOfDay,
} from "@/lib/cadence";
import { executeRun, fields } from "./run-engine";
import { statusLabel } from "./scheduler";

/**
 * The schedules screen's writes.
 *
 * Every one of these re-checks ownership against the session rather than
 * trusting the id in the form, because a Server Action is reachable by direct
 * POST whether or not the button that calls it is on screen.
 */

/**
 * `attempt` counts replies, and the form uses it as a React key.
 *
 * React resets a form once its action resolves, which puts every field back to
 * its default in the DOM while the component's state still holds what the user
 * chose. The two then disagree silently: the screen shows "every Wednesday" and
 * the next submit sends "every hour". Remounting on each reply re-applies the
 * state, so what is on screen is what gets saved.
 */
export type ScheduleState = { error?: string; attempt?: number };

function reply(previous: ScheduleState, error?: string): ScheduleState {
  return { error, attempt: (previous.attempt ?? 0) + 1 };
}

export async function createSchedule(
  previous: ScheduleState,
  formData: FormData,
): Promise<ScheduleState> {
  const user = await requireUser();

  const installationId = String(formData.get("installationId") ?? "");
  const cadence = String(formData.get("cadence") ?? "daily");
  const time = String(formData.get("time") ?? "09:00");
  const weekday = Number(formData.get("weekday") ?? 0);

  if (!isCadence(cadence)) return reply(previous, "Pick how often it should run.");
  if (cadence !== "hourly" && !isTimeOfDay(time)) {
    return reply(previous, "Give a time as HH:MM, on the 24-hour clock.");
  }
  if (!Number.isInteger(weekday) || weekday < 0 || weekday > 6) {
    return reply(previous, "Pick a day of the week.");
  }

  const installation = await prisma.installation.findFirst({
    where: { id: installationId, userId: user.id, status: { in: ["ACTIVE", "PARTIAL"] } },
    include: { product: true },
  });
  if (!installation) return reply(previous, "Pick something from your workspace.");

  // A scheduled run cannot stop to ask, so everything the product declares as
  // required has to be here now. Collecting it later would mean a schedule that
  // silently comes back "needs input" every time it fires.
  const args: Record<string, unknown> = {};
  const missing: string[] = [];
  for (const field of fields(installation.product)) {
    const raw = formData.get(`arg.${field.name}`);
    const value = raw === null ? "" : String(raw).trim();

    if (!value) {
      if (field.required !== false) missing.push(field.label);
      continue;
    }
    args[field.name] = field.type === "number" ? Number(value) : value;
  }

  if (missing.length > 0) {
    return reply(
      previous,
      `${missing.join(", ")} ${missing.length > 1 ? "are" : "is"} needed every time this runs, so it has to be set now.`,
    );
  }

  const cron = cronFor(cadence, time, weekday);

  let due: Date;
  try {
    due = nextRun(cron);
  } catch (error) {
    return reply(previous, error instanceof Error ? error.message : "That schedule cannot run.");
  }

  await prisma.schedule.create({
    data: {
      userId: user.id,
      installationId: installation.id,
      label: cadenceLabel(cadence, time, weekday),
      cron,
      args: args as never,
      nextRunAt: due,
    },
  });

  revalidatePath("/results");
  revalidatePath("/workspace");
  return reply(previous);
}

export async function setScheduleEnabled(formData: FormData) {
  const user = await requireUser();
  const id = String(formData.get("scheduleId") ?? "");
  const enabled = String(formData.get("enabled") ?? "") === "on";

  const schedule = await prisma.schedule.findFirst({
    where: { id, userId: user.id },
  });
  if (!schedule) return;

  // Resuming recomputes the next time from now. Keeping the old one would fire
  // immediately for every window that passed while it was paused.
  let due: Date | null = null;
  if (enabled) {
    try {
      due = nextRun(schedule.cron);
    } catch {
      return;
    }
  }

  await prisma.schedule.update({
    where: { id: schedule.id },
    data: { enabled, nextRunAt: enabled ? due : null },
  });

  revalidatePath("/results");
}

export async function deleteSchedule(formData: FormData) {
  const user = await requireUser();
  const id = String(formData.get("scheduleId") ?? "");

  // deleteMany, so an id belonging to someone else deletes nothing rather than
  // throwing and telling the caller the row exists.
  await prisma.schedule.deleteMany({ where: { id, userId: user.id } });

  revalidatePath("/results");
  revalidatePath("/workspace");
}

/** "Run now" — the same firing the tick would do, without waiting for it. */
export async function runScheduleNow(formData: FormData) {
  const user = await requireUser();
  const id = String(formData.get("scheduleId") ?? "");

  const schedule = await prisma.schedule.findFirst({
    where: { id, userId: user.id },
  });
  if (!schedule) return;

  const args =
    schedule.args && typeof schedule.args === "object" && !Array.isArray(schedule.args)
      ? (schedule.args as Record<string, unknown>)
      : {};

  const run = await executeRun({
    user,
    installationId: schedule.installationId,
    args,
  });

  // Running early does not move the next scheduled time: the user asked for one
  // extra run, not for the schedule to drift.
  await prisma.schedule.update({
    where: { id: schedule.id },
    data: {
      lastRunAt: new Date(),
      lastStatus: statusLabel(run),
      lastRunId: run?.id ?? null,
    },
  });

  revalidatePath("/results");
}
