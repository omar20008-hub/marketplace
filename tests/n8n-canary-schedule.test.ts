import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The hourly gate around the n8n check in the server's own scheduler: it runs at
 * most once an hour, and only where the platform really talks to n8n.
 */

vi.hoisted(() => {
  process.env.N8N_DRIVER = "live";
  process.env.N8N_BASE_URL = "https://n8n.test/api/v1";
});
vi.mock("server-only", () => ({}));

const { prisma } = await import("@/lib/db");
const { maybeRunCanary, resetCanaryClock } = await import("@/server/knowledge/scheduler");

const HOUR = 60 * 60 * 1000;
/** A clock well past the epoch, as a real one is. */
const T0 = 10 * HOUR;
const status = { state: "ok" as const, checkedAt: "", since: "", caughtUp: 0 };

beforeEach(() => resetCanaryClock());
afterAll(() => prisma.$disconnect());

describe("maybeRunCanary", () => {
  it("runs the first time and logs what it found", async () => {
    const check = vi.fn(async () => status);
    const log = vi.fn();
    expect(await maybeRunCanary(T0, check, log)).toBe(true);
    expect(check).toHaveBeenCalledOnce();
    expect(log).toHaveBeenCalledWith("n8n check: ok, caught up 0");
  });

  it("does not run again within the hour", async () => {
    const check = vi.fn(async () => status);
    await maybeRunCanary(T0, check, vi.fn());
    expect(await maybeRunCanary(T0 + HOUR - 1, check, vi.fn())).toBe(false);
    expect(check).toHaveBeenCalledOnce();
  });

  it("runs again once the hour has passed", async () => {
    const check = vi.fn(async () => status);
    await maybeRunCanary(T0, check, vi.fn());
    expect(await maybeRunCanary(T0 + HOUR, check, vi.fn())).toBe(true);
    expect(check).toHaveBeenCalledTimes(2);
  });
});
