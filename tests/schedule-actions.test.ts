import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The schedules screen's writes, with the session and revalidation replaced.
 */

/**
 * requireUser() returns the viewer with their plan included, and executeRun()
 * reads the run allowance straight off it. The stand-in has to carry the plan
 * too, or these tests would pass against a shape production never produces.
 */
const viewer = vi.hoisted(() => ({
  current: null as { id: string; plan?: unknown } | null,
}));

vi.mock("@/lib/auth", () => ({
  requireUser: async () => {
    if (!viewer.current) throw new Error("no session in this test");
    return viewer.current;
  },
}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

const { prisma } = await import("@/lib/db");
const {
  createSchedule,
  deleteSchedule,
  runScheduleNow,
  setScheduleEnabled,
} = await import("@/server/schedule-actions");

const PLAN_ID = "test-plan-schedule-actions";

async function wipe() {
  await prisma.artifact.deleteMany({});
  await prisma.runStep.deleteMany({});
  await prisma.run.deleteMany({});
  await prisma.schedule.deleteMany({});
  await prisma.installation.deleteMany({});
  await prisma.product.deleteMany({});
  await prisma.user.deleteMany({});
  await prisma.plan.deleteMany({});
}

async function seed({ inputSchema = [] as unknown[] } = {}) {
  await prisma.plan.create({
    data: {
      id: PLAN_ID,
      name: "Test",
      monthlyRuns: 100,
      storageBytes: BigInt(1_000_000),
      monthlyCredits: 0,
    },
  });
  const user = await prisma.user.create({
    data: {
      email: "owner@example.test",
      name: "Owner",
      passwordHash: "x",
      initials: "OW",
      planId: PLAN_ID,
    },
    include: { plan: true },
  });
  viewer.current = user;

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

function form(values: Record<string, string>) {
  const data = new FormData();
  for (const [key, value] of Object.entries(values)) data.append(key, value);
  return data;
}

beforeEach(wipe);
afterAll(async () => {
  await wipe();
  await prisma.$disconnect();
});

describe("createSchedule — the cadence becomes a cron", () => {
  it.each([
    ["hourly", "0 * * * *", "Every hour"],
    ["daily", "45 14 * * *", "Every day 14:45 UTC"],
    ["weekdays", "45 14 * * 1-5", "Weekdays 14:45 UTC"],
    ["monthly", "45 14 1 * *", "1st of the month 14:45 UTC"],
  ])("%s", async (cadence, cron, label) => {
    const { installation } = await seed();

    const state = await createSchedule(
      {},
      form({ installationId: installation.id, cadence, time: "14:45" }),
    );

    expect(state.error).toBeUndefined();
    const schedule = await prisma.schedule.findFirst();
    expect(schedule).toMatchObject({ cron, label, enabled: true });
    expect(schedule!.nextRunAt).toBeInstanceOf(Date);
    expect(schedule!.nextRunAt!.getTime()).toBeGreaterThan(Date.now());
  });

  it("weekly uses the day that was picked", async () => {
    const { installation } = await seed();

    await createSchedule(
      {},
      form({
        installationId: installation.id,
        cadence: "weekly",
        time: "14:45",
        weekday: "3",
      }),
    );

    const schedule = await prisma.schedule.findFirst();
    expect(schedule).toMatchObject({
      cron: "45 14 * * 3",
      label: "Every Wednesday 14:45 UTC",
    });
    // The first run really is a Wednesday.
    expect(schedule!.nextRunAt!.getUTCDay()).toBe(3);
  });
});

describe("createSchedule — what it refuses", () => {
  it("refuses an installation that is not the caller's", async () => {
    const { installation } = await seed();
    const stranger = await prisma.user.create({
      data: {
        email: "stranger@example.test",
        name: "Stranger",
        passwordHash: "x",
        initials: "ST",
        planId: PLAN_ID,
      },
      include: { plan: true },
    });
    viewer.current = stranger;

    const state = await createSchedule(
      {},
      form({ installationId: installation.id, cadence: "daily", time: "09:00" }),
    );

    expect(state.error).toMatch(/workspace/);
    expect(await prisma.schedule.count()).toBe(0);
  });

  it("refuses a cadence it does not offer", async () => {
    const { installation } = await seed();

    const state = await createSchedule(
      {},
      form({ installationId: installation.id, cadence: "fortnightly", time: "09:00" }),
    );

    expect(state.error).toMatch(/how often/);
  });

  it.each(["9:00", "25:00", "09:60", "nine"])("refuses the time %s", async (time) => {
    const { installation } = await seed();

    const state = await createSchedule(
      {},
      form({ installationId: installation.id, cadence: "daily", time }),
    );

    expect(state.error).toMatch(/HH:MM/);
  });

  it("refuses a weekday outside the week", async () => {
    const { installation } = await seed();

    const state = await createSchedule(
      {},
      form({
        installationId: installation.id,
        cadence: "weekly",
        time: "09:00",
        weekday: "9",
      }),
    );

    expect(state.error).toMatch(/day of the week/);
  });

  it("refuses to save without the inputs every firing will need", async () => {
    const { installation } = await seed({
      inputSchema: [{ name: "channel", label: "Channel", type: "string", required: true }],
    });

    const state = await createSchedule(
      {},
      form({ installationId: installation.id, cadence: "daily", time: "09:00" }),
    );

    expect(state.error).toMatch(/Channel is needed/);
    expect(await prisma.schedule.count()).toBe(0);
  });

  it("stores the inputs it was given, typed as the product declares them", async () => {
    const { installation } = await seed({
      inputSchema: [
        { name: "channel", label: "Channel", type: "string", required: true },
        { name: "days", label: "Days", type: "number", required: true },
        { name: "note", label: "Note", type: "string", required: false },
      ],
    });

    await createSchedule(
      {},
      form({
        installationId: installation.id,
        cadence: "daily",
        time: "09:00",
        "arg.channel": "#sales",
        "arg.days": "30",
        "arg.note": "",
      }),
    );

    // The blank optional field is left out rather than stored as "".
    expect((await prisma.schedule.findFirst())!.args).toEqual({
      channel: "#sales",
      days: 30,
    });
  });
});

describe("createSchedule — the reply", () => {
  it("counts every attempt, which is what keeps the form in step with itself", async () => {
    // React puts a form back to its defaults once the action resolves. The form
    // remounts on this number so its fields are redrawn from state; if it ever
    // stopped changing, a second submit would quietly send the first one's
    // values again.
    const { installation } = await seed();
    const good = form({
      installationId: installation.id,
      cadence: "daily",
      time: "09:00",
    });

    const first = await createSchedule({}, form({ cadence: "nope" }));
    expect(first.attempt).toBe(1);

    const second = await createSchedule(first, form({ cadence: "nope" }));
    expect(second.attempt).toBe(2);

    const third = await createSchedule(second, good);
    expect(third).toMatchObject({ attempt: 3, error: undefined });
  });
});

describe("pausing and resuming", () => {
  it("pausing clears the next run, so resuming cannot fire for a missed window", async () => {
    const { user, installation } = await seed();
    await createSchedule(
      {},
      form({ installationId: installation.id, cadence: "daily", time: "09:00" }),
    );
    const schedule = await prisma.schedule.findFirst();

    await setScheduleEnabled(form({ scheduleId: schedule!.id }));
    const paused = await prisma.schedule.findUnique({ where: { id: schedule!.id } });
    expect(paused).toMatchObject({ enabled: false, nextRunAt: null });

    await setScheduleEnabled(form({ scheduleId: schedule!.id, enabled: "on" }));
    const resumed = await prisma.schedule.findUnique({ where: { id: schedule!.id } });
    expect(resumed!.enabled).toBe(true);
    expect(resumed!.nextRunAt!.getTime()).toBeGreaterThan(Date.now());
    expect(resumed!.userId).toBe(user.id);
  });

  it("will not pause someone else's schedule", async () => {
    const { installation } = await seed();
    await createSchedule(
      {},
      form({ installationId: installation.id, cadence: "daily", time: "09:00" }),
    );
    const schedule = await prisma.schedule.findFirst();

    viewer.current = await prisma.user.create({
      data: {
        email: "nosy@example.test",
        name: "Nosy",
        passwordHash: "x",
        initials: "NO",
        planId: PLAN_ID,
      },
      include: { plan: true },
    });

    await setScheduleEnabled(form({ scheduleId: schedule!.id }));

    expect(await prisma.schedule.findUnique({ where: { id: schedule!.id } })).toMatchObject(
      { enabled: true },
    );
  });
});

describe("deleteSchedule", () => {
  it("deletes the caller's own", async () => {
    const { installation } = await seed();
    await createSchedule(
      {},
      form({ installationId: installation.id, cadence: "daily", time: "09:00" }),
    );
    const schedule = await prisma.schedule.findFirst();

    await deleteSchedule(form({ scheduleId: schedule!.id }));
    expect(await prisma.schedule.count()).toBe(0);
  });

  it("deletes nothing when the id is someone else's", async () => {
    const { installation } = await seed();
    await createSchedule(
      {},
      form({ installationId: installation.id, cadence: "daily", time: "09:00" }),
    );
    const schedule = await prisma.schedule.findFirst();

    viewer.current = await prisma.user.create({
      data: {
        email: "nosy2@example.test",
        name: "Nosy",
        passwordHash: "x",
        initials: "NO",
        planId: PLAN_ID,
      },
      include: { plan: true },
    });

    await deleteSchedule(form({ scheduleId: schedule!.id }));
    expect(await prisma.schedule.count()).toBe(1);
  });
});

describe("runScheduleNow", () => {
  it("runs once and leaves the next scheduled time where it was", async () => {
    // Running early is an extra run, not a reason for the schedule to drift.
    const { installation } = await seed();
    await createSchedule(
      {},
      form({ installationId: installation.id, cadence: "daily", time: "09:00" }),
    );
    const before = await prisma.schedule.findFirst();

    await runScheduleNow(form({ scheduleId: before!.id }));

    const after = await prisma.schedule.findUnique({ where: { id: before!.id } });
    expect(after!.nextRunAt).toEqual(before!.nextRunAt);
    expect(after!.lastStatus).toBe("Succeeded");
    expect(after!.lastRunAt).toBeInstanceOf(Date);
    expect(await prisma.run.count()).toBe(1);
  });

  it("will not run someone else's schedule", async () => {
    const { installation } = await seed();
    await createSchedule(
      {},
      form({ installationId: installation.id, cadence: "daily", time: "09:00" }),
    );
    const schedule = await prisma.schedule.findFirst();

    viewer.current = await prisma.user.create({
      data: {
        email: "nosy3@example.test",
        name: "Nosy",
        passwordHash: "x",
        initials: "NO",
        planId: PLAN_ID,
      },
      include: { plan: true },
    });

    await runScheduleNow(form({ scheduleId: schedule!.id }));
    expect(await prisma.run.count()).toBe(0);
  });
});
