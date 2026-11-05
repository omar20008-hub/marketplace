import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The hourly n8n check and the catch-up. The probe and the install are replaced by
 * spies; the status it stores and the people it picks run against Postgres.
 */

const state = vi.hoisted(() => ({ probe: vi.fn(), install: vi.fn() }));

vi.mock("@/lib/n8n/live", () => ({ probeN8nApi: state.probe }));
vi.mock("@/server/auto-install", () => ({ installReadyProducts: state.install }));
vi.mock("server-only", () => ({}));

const { prisma } = await import("@/lib/db");
const { runN8nCanary, N8N_STATUS_KEY } = await import("@/server/n8n-canary");

const PLAN_ID = "canary-plan";

async function wipe() {
  await prisma.platformStatus.deleteMany({});
  await prisma.installation.deleteMany({});
  await prisma.user.deleteMany({});
  await prisma.plan.deleteMany({});
}

async function person(createdAt: Date) {
  await prisma.plan.upsert({
    where: { id: PLAN_ID },
    update: {},
    create: { id: PLAN_ID, name: "Test", monthlyRuns: 100, storageBytes: BigInt(1_000_000), monthlyCredits: 0 },
  });
  return prisma.user.create({
    data: {
      email: `p-${Math.random()}@test.local`,
      name: "P",
      passwordHash: "x",
      initials: "P",
      planId: PLAN_ID,
      createdAt,
    },
  });
}

beforeEach(async () => {
  await wipe();
  state.probe.mockReset();
  state.install.mockReset();
  state.install.mockResolvedValue({ installed: ["digest"], skipped: 0 });
});
afterAll(async () => {
  await wipe();
  await prisma.$disconnect();
});

describe("runN8nCanary", () => {
  it("stores a rejected key and gives no one an install", async () => {
    state.probe.mockResolvedValue("rejected");
    await person(new Date());

    const status = await runN8nCanary();

    expect(status.state).toBe("rejected");
    expect(state.install).not.toHaveBeenCalled();
    const stored = await prisma.platformStatus.findUniqueOrThrow({ where: { key: N8N_STATUS_KEY } });
    expect((stored.value as { state: string }).state).toBe("rejected");
  });

  it("gives the products missed during a refusal once the key is accepted", async () => {
    state.probe.mockResolvedValue("ok");
    const recent = await person(new Date());
    await person(new Date(Date.now() - 30 * 24 * 60 * 60 * 1000));

    const status = await runN8nCanary();

    expect(status.caughtUp).toBe(1);
    expect(state.install).toHaveBeenCalledTimes(1);
    expect(state.install).toHaveBeenCalledWith(recent.id);
  });

  it("keeps the time a state began, so a long outage shows as long", async () => {
    const began = new Date("2026-11-01T00:00:00.000Z");
    state.probe.mockResolvedValue("unreachable");
    await runN8nCanary(began);
    const later = await runN8nCanary(new Date("2026-11-02T00:00:00.000Z"));
    expect(later.since).toBe(began.toISOString());
  });
});
