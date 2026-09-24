import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { prisma } from "@/lib/db";
import { runDueSchedules, statusLabel } from "@/server/scheduler";
import type { Run } from "@/generated/prisma";

/**
 * The tick, against a real database and the mock driver.
 *
 * The cases that matter are the ones a scheduler gets wrong quietly: firing
 * once per missed window after downtime, firing twice when two ticks overlap,
 * and firing at all for a row that has never been scheduled.
 */

const PLAN_ID = "test-plan-scheduler";

async function wipe() {
  await prisma.artifact.deleteMany({});
  await prisma.runStep.deleteMany({});
  await prisma.run.deleteMany({});
  await prisma.schedule.deleteMany({});
  await prisma.installationCredential.deleteMany({});
  await prisma.installation.deleteMany({});
  await prisma.requirement.deleteMany({});
  await prisma.connectedAccount.deleteMany({});
  await prisma.product.deleteMany({});
  await prisma.user.deleteMany({});
  await prisma.plan.deleteMany({});
}

async function seed({
  monthlyRuns = 100,
  requirements = [] as {
    kind: "CONNECTION";
    label: string;
    credentialType: string;
    providedBy: "USER" | "PLATFORM";
  }[],
  inputSchema = [] as unknown[],
} = {}) {
  await prisma.plan.create({
    data: {
      id: PLAN_ID,
      name: "Test",
      monthlyRuns,
      storageBytes: BigInt(1_000_000),
      monthlyCredits: 0,
    },
  });
  const user = await prisma.user.create({
    data: {
      email: "sched@example.test",
      name: "Sched",
      passwordHash: "x",
      initials: "SC",
      planId: PLAN_ID,
    },
  });
  const product = await prisma.product.create({
    data: {
      slug: `p-${Math.random().toString(36).slice(2, 8)}`,
      creatorId: user.id,
      title: "Digest",
      summary: "s",
      description: "d",
      needsFromYou: "n",
      kind: "WORKFLOW",
      category: "Reporting",
      status: "PUBLISHED",
      inputSchema: inputSchema as never,
      requirements: { create: requirements },
    },
  });
  const installation = await prisma.installation.create({
    data: {
      userId: user.id,
      productId: product.id,
      pinnedVersion: "1.0",
      status: "ACTIVE",
      installationId: `inst_${Math.random().toString(36).slice(2, 8)}`,
    },
  });
  return { user, product, installation };
}

async function makeSchedule(
  userId: string,
  installationId: string,
  overrides: Record<string, unknown> = {},
) {
  return prisma.schedule.create({
    data: {
      userId,
      installationId,
      label: "Every day 07:00 UTC",
      cron: "0 7 * * *",
      nextRunAt: new Date("2026-03-10T07:00:00.000Z"),
      ...overrides,
    },
  });
}

const LATER = new Date("2026-03-10T07:00:30.000Z");

beforeEach(wipe);
afterAll(async () => {
  await wipe();
  await prisma.$disconnect();
});

describe("what the tick picks up", () => {
  it("runs a schedule that is due", async () => {
    const { user, installation } = await seed();
    const schedule = await makeSchedule(user.id, installation.id);

    const summary = await runDueSchedules({ now: LATER });

    expect(summary.ran).toBe(1);
    expect(summary.outcomes[0]).toMatchObject({
      scheduleId: schedule.id,
      action: "ran",
      status: "Succeeded",
    });
    expect(await prisma.run.count()).toBe(1);
  });

  it("leaves a schedule that is not due yet alone", async () => {
    const { user, installation } = await seed();
    await makeSchedule(user.id, installation.id, {
      nextRunAt: new Date("2026-03-11T07:00:00.000Z"),
    });

    const summary = await runDueSchedules({ now: LATER });

    expect(summary).toMatchObject({ checked: 0, ran: 0 });
    expect(await prisma.run.count()).toBe(0);
  });

  it("leaves a paused schedule alone even when it is overdue", async () => {
    const { user, installation } = await seed();
    await makeSchedule(user.id, installation.id, {
      enabled: false,
      nextRunAt: new Date("2020-01-01T00:00:00.000Z"),
    });

    expect(await runDueSchedules({ now: LATER })).toMatchObject({ checked: 0 });
    expect(await prisma.run.count()).toBe(0);
  });

  it("sets a first time for a schedule that has none, instead of firing it", async () => {
    // Otherwise a null nextRunAt reads as "overdue since the epoch", and every
    // freshly seeded schedule fires the moment the first tick runs.
    const { user, installation } = await seed();
    const schedule = await makeSchedule(user.id, installation.id, {
      nextRunAt: null,
    });

    const summary = await runDueSchedules({ now: LATER });

    expect(summary.outcomes[0]).toMatchObject({ action: "initialised" });
    expect(await prisma.run.count()).toBe(0);

    const after = await prisma.schedule.findUnique({ where: { id: schedule.id } });
    expect(after!.nextRunAt).toEqual(new Date("2026-03-11T07:00:00.000Z"));
  });

  it("honours the limit and leaves the rest for the next tick", async () => {
    const { user, installation } = await seed();
    for (let i = 0; i < 3; i++) await makeSchedule(user.id, installation.id);

    const summary = await runDueSchedules({ now: LATER, limit: 2 });

    expect(summary.checked).toBe(2);
    expect(await prisma.run.count()).toBe(2);
  });
});

describe("a missed window", () => {
  it("fires once after a week of downtime, not once per missed day", async () => {
    const { user, installation } = await seed();
    const schedule = await makeSchedule(user.id, installation.id, {
      nextRunAt: new Date("2026-03-03T07:00:00.000Z"),
    });

    await runDueSchedules({ now: LATER });

    expect(await prisma.run.count()).toBe(1);

    // And the next time is ahead of now, not the next missed one behind it.
    const after = await prisma.schedule.findUnique({ where: { id: schedule.id } });
    expect(after!.nextRunAt).toEqual(new Date("2026-03-11T07:00:00.000Z"));
  });

  it("does not fire again on a second tick in the same minute", async () => {
    const { user, installation } = await seed();
    await makeSchedule(user.id, installation.id);

    await runDueSchedules({ now: LATER });
    const second = await runDueSchedules({ now: LATER });

    expect(second).toMatchObject({ checked: 0, ran: 0 });
    expect(await prisma.run.count()).toBe(1);
  });
});

describe("two ticks at once", () => {
  it("runs a due schedule exactly once", async () => {
    // The claim is a compare-and-swap on nextRunAt, so of two overlapping ticks
    // one takes the schedule and the other finds it already moved on.
    const { user, installation } = await seed();
    await makeSchedule(user.id, installation.id);

    const [a, b] = await Promise.all([
      runDueSchedules({ now: LATER }),
      runDueSchedules({ now: LATER }),
    ]);

    expect(a.ran + b.ran).toBe(1);
    expect(await prisma.run.count()).toBe(1);
  });

  it("runs each of several due schedules exactly once across concurrent ticks", async () => {
    const { user, installation } = await seed();
    for (let i = 0; i < 4; i++) await makeSchedule(user.id, installation.id);

    const ticks = await Promise.all([
      runDueSchedules({ now: LATER }),
      runDueSchedules({ now: LATER }),
      runDueSchedules({ now: LATER }),
    ]);

    expect(ticks.reduce((total, tick) => total + tick.ran, 0)).toBe(4);
    expect(await prisma.run.count()).toBe(4);
  });
});

describe("the arguments a schedule carries", () => {
  it("runs with its saved inputs, so a required field is satisfied", async () => {
    const { user, installation } = await seed({
      inputSchema: [{ name: "channel", label: "Channel", type: "string", required: true }],
    });
    await makeSchedule(user.id, installation.id, { args: { channel: "#sales" } });

    const summary = await runDueSchedules({ now: LATER });

    expect(summary.outcomes[0]).toMatchObject({ status: "Succeeded" });
  });

  it("records that it needs input when the saved args do not cover the product", async () => {
    // The honest outcome when a product has gained a required field since the
    // schedule was made: the run is recorded incomplete, not silently skipped.
    const { user, installation } = await seed({
      inputSchema: [{ name: "channel", label: "Channel", type: "string", required: true }],
    });
    await makeSchedule(user.id, installation.id, { args: {} });

    const summary = await runDueSchedules({ now: LATER });

    expect(summary.outcomes[0]).toMatchObject({ status: "Needs input" });
    expect(await prisma.run.findFirst()).toMatchObject({
      result: "INCOMPLETE",
      charged: false,
    });
  });
});

describe("the same refusals a person would get", () => {
  it("records a blocked run when a connection is missing, and charges nothing", async () => {
    const { user, installation } = await seed({
      requirements: [
        {
          kind: "CONNECTION",
          label: "Slack",
          credentialType: "slackApi",
          providedBy: "USER",
        },
      ],
    });
    const schedule = await makeSchedule(user.id, installation.id);

    const summary = await runDueSchedules({ now: LATER });

    expect(summary.outcomes[0].status).toMatch(/^Blocked/);
    expect(await prisma.run.findFirst()).toMatchObject({ charged: false });

    const after = await prisma.schedule.findUnique({ where: { id: schedule.id } });
    expect(after!.lastStatus).toMatch(/^Blocked/);
    // Still scheduled: a missing connection is something the user can fix.
    expect(after!.enabled).toBe(true);
  });

  it("stops at the plan limit rather than spending past it", async () => {
    const { user, installation } = await seed({ monthlyRuns: 1 });
    await makeSchedule(user.id, installation.id);
    await makeSchedule(user.id, installation.id);

    const summary = await runDueSchedules({ now: LATER });

    const statuses = summary.outcomes.map((outcome) => outcome.status);
    expect(statuses).toContain("Succeeded");
    expect(statuses.some((status) => status?.includes("plan limit"))).toBe(true);
  });
});

describe("a schedule that can never run", () => {
  it("is turned off, with the reason where its owner will see it", async () => {
    const { user, installation } = await seed();
    const schedule = await makeSchedule(user.id, installation.id, {
      cron: "0 0 30 2 *",
    });

    const summary = await runDueSchedules({ now: LATER });

    expect(summary.outcomes[0]).toMatchObject({ action: "disabled" });
    const after = await prisma.schedule.findUnique({ where: { id: schedule.id } });
    expect(after!.enabled).toBe(false);
    expect(after!.lastStatus).toMatch(/never fire/);
    expect(await prisma.run.count()).toBe(0);
  });

  it("is turned off when the expression cannot be read at all", async () => {
    const { user, installation } = await seed();
    await makeSchedule(user.id, installation.id, { cron: "not a cron" });

    const summary = await runDueSchedules({ now: LATER });

    expect(summary.outcomes[0]).toMatchObject({ action: "disabled" });
  });

  it("does not stop the tick reaching the schedules after it", async () => {
    const { user, installation } = await seed();
    await makeSchedule(user.id, installation.id, {
      cron: "nonsense",
      nextRunAt: new Date("2026-03-01T07:00:00.000Z"),
    });
    await makeSchedule(user.id, installation.id);

    const summary = await runDueSchedules({ now: LATER });

    expect(summary.checked).toBe(2);
    expect(summary.ran).toBe(1);
  });
});

describe("the owner", () => {
  it("comes from the schedule row, so the run belongs to them", async () => {
    const { user, installation } = await seed();
    await makeSchedule(user.id, installation.id);

    await runDueSchedules({ now: LATER });

    expect(await prisma.run.findFirst()).toMatchObject({ userId: user.id });
  });
});

describe("statusLabel", () => {
  const run = (result: string, errorType?: string) =>
    ({ result, errorType: errorType ?? null }) as unknown as Run;

  it.each([
    ["SUCCESS", undefined, "Succeeded"],
    ["PARTIAL", undefined, "Partly done"],
    ["INCOMPLETE", undefined, "Needs input"],
    ["BLOCKED", "plan limit", "Blocked · plan limit"],
    ["BLOCKED", undefined, "Blocked"],
    ["DENIED", undefined, "Denied"],
    ["STOPPED", undefined, "Stopped"],
    ["ERROR", undefined, "Failed"],
  ])("reads %s as %s", (result, errorType, expected) => {
    expect(statusLabel(run(result, errorType))).toBe(expected);
  });

  it("says so when there was no run at all", () => {
    expect(statusLabel(null)).toBe("Could not start");
  });
});
