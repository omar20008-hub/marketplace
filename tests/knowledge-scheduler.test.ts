import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The in-process knowledge tick: when it starts, that two passes never overlap,
 * that a failure does not stop the next one, and that a pass leaves the same
 * "last tick" mark an outside caller would.
 */

vi.mock("@/server/google-account", () => ({
  getGoogleAccessToken: vi.fn(async () => "token"),
  saveGoogleConnection: vi.fn(),
}));
vi.mock("@/server/knowledge/watch", () => ({
  ensureWatch: vi.fn(async () => {}),
  renewWatches: vi.fn(async () => ({ renewed: 0, failed: 0 })),
  stopWatch: vi.fn(async () => {}),
}));

const { prisma } = await import("@/lib/db");
const { parseTickInterval, MIN_TICK_INTERVAL_SECONDS } = await import("@/lib/tick-interval");
const {
  createScheduler,
  describeError,
  runScheduledPass,
  shouldRunScheduler,
  startKnowledgeScheduler,
  withTickLock,
} = await import("@/server/knowledge/scheduler");
const { queueHealth } = await import("@/server/knowledge/heartbeat");
const { tickKnowledge } = await import("@/server/knowledge/worker");

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

beforeEach(async () => {
  await prisma.heartbeat.deleteMany({});
  await prisma.knowledgeJob.deleteMany({});
});
afterEach(() => {
  vi.restoreAllMocks();
  delete (globalThis as { __knowledgeScheduler?: unknown }).__knowledgeScheduler;
});
afterAll(async () => {
  await prisma.heartbeat.deleteMany({});
  await prisma.$disconnect();
});

describe("KNOWLEDGE_TICK_INTERVAL_SECONDS", () => {
  it("is off unless it is a positive number", () => {
    for (const raw of [undefined, "", "  ", "0", "-5", "abc", "NaN", "Infinity"]) {
      expect(parseTickInterval(raw), `${JSON.stringify(raw)}`).toBe(0);
    }
  });

  it("reads seconds, and raises a too-small value to the floor", () => {
    expect(parseTickInterval("60")).toBe(60);
    expect(parseTickInterval(" 90 ")).toBe(90);
    expect(parseTickInterval("30.9")).toBe(30);
    expect(parseTickInterval("1")).toBe(MIN_TICK_INTERVAL_SECONDS);
  });
});

describe("shouldRunScheduler", () => {
  const base = { intervalSeconds: 60, nodeEnv: "production", phase: undefined, inDev: false };

  it("runs in production when enabled", () => {
    expect(shouldRunScheduler(base)).toBe(true);
  });

  it("does not run when disabled, whatever else is true", () => {
    expect(shouldRunScheduler({ ...base, intervalSeconds: 0 })).toBe(false);
    expect(shouldRunScheduler({ ...base, intervalSeconds: 0, inDev: true })).toBe(false);
  });

  it("never runs during next build or under the test runner", () => {
    expect(shouldRunScheduler({ ...base, phase: "phase-production-build" })).toBe(false);
    expect(shouldRunScheduler({ ...base, nodeEnv: "test", inDev: true })).toBe(false);
  });

  it("runs in development only when asked", () => {
    expect(shouldRunScheduler({ ...base, nodeEnv: "development" })).toBe(false);
    expect(shouldRunScheduler({ ...base, nodeEnv: "development", inDev: true })).toBe(true);
  });
});

describe("startKnowledgeScheduler", () => {
  it("does not start here: the test runner is never a place to run a clock", () => {
    expect(startKnowledgeScheduler()).toBeNull();
  });
});

describe("the lock", () => {
  it("lets one pass run and turns a simultaneous one away", async () => {
    let inside = 0;
    let maxInside = 0;
    const slow = async () => {
      inside++;
      maxInside = Math.max(maxInside, inside);
      await sleep(150);
      inside--;
      return "done";
    };
    const results = await Promise.all([withTickLock(slow), withTickLock(slow), withTickLock(slow)]);
    expect(results.filter((r) => r.ran)).toHaveLength(1);
    expect(maxInside).toBe(1);
  });

  it("is released when the pass ends — so the next one runs — and when it fails", async () => {
    expect((await withTickLock(async () => 1)).ran).toBe(true);
    await expect(
      withTickLock(async () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    const again = await withTickLock(async () => "ok");
    expect(again).toEqual({ ran: true, value: "ok" });
  });
});

describe("a pass", () => {
  it("leaves the last-tick mark, so the Files page does not call a working scheduler stopped", async () => {
    expect((await queueHealth()).lastTickAgeSeconds).toBeNull();
    const lines: string[] = [];
    await runScheduledPass(tickKnowledge, (line) => lines.push(line));
    expect((await queueHealth()).lastTickAgeSeconds).toBeLessThan(5);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(/^knowledge tick ok: queued=0 ran=0 failed=0 gaveUp=0$/);
  });

  it("says so, and does not run the tick, if another pass holds the lock", async () => {
    const tick = vi.fn(tickKnowledge);
    const lines: string[] = [];
    await withTickLock(async () => {
      await runScheduledPass(tick, (line) => lines.push(line));
    });
    expect(tick).not.toHaveBeenCalled();
    expect(lines[0]).toMatch(/skipped/);
  });
});

describe("createScheduler", () => {
  it("keeps running after a pass fails, and reports the failure", async () => {
    let calls = 0;
    const errors: unknown[] = [];
    const scheduler = createScheduler({
      intervalMs: 15,
      firstDelayMs: 0,
      pass: async () => {
        calls++;
        if (calls === 2) throw new Error("db went away");
      },
      onError: (error) => errors.push(error),
    });
    await sleep(250);
    scheduler.stop();
    expect(calls).toBeGreaterThanOrEqual(4);
    expect(errors).toHaveLength(1);
  });

  it("does not let a throwing error reporter stop it either", async () => {
    let calls = 0;
    const scheduler = createScheduler({
      intervalMs: 15,
      firstDelayMs: 0,
      pass: async () => {
        calls++;
        throw new Error("always");
      },
      onError: () => {
        throw new Error("the log is broken");
      },
    });
    await sleep(150);
    scheduler.stop();
    expect(calls).toBeGreaterThanOrEqual(3);
  });

  it("never runs two passes at once, even when one is slower than the interval", async () => {
    let inside = 0;
    let maxInside = 0;
    let calls = 0;
    const scheduler = createScheduler({
      intervalMs: 10,
      firstDelayMs: 0,
      pass: async () => {
        calls++;
        inside++;
        maxInside = Math.max(maxInside, inside);
        await sleep(40);
        inside--;
      },
      onError: () => {},
    });
    await sleep(300);
    scheduler.stop();
    expect(calls).toBeGreaterThanOrEqual(3);
    expect(maxInside).toBe(1);
  });

  it("waits the interval from the start of a pass, not from its end", async () => {
    const starts: number[] = [];
    const scheduler = createScheduler({
      intervalMs: 100,
      firstDelayMs: 0,
      pass: async () => {
        starts.push(Date.now());
        await sleep(60);
      },
      onError: () => {},
    });
    await sleep(380);
    scheduler.stop();
    const gaps = starts.slice(1).map((t, i) => t - starts[i]);
    expect(gaps.length).toBeGreaterThanOrEqual(2);
    for (const gap of gaps) expect(gap).toBeLessThan(140); // 100 + slack, not 160
  });

  it("stops: no pass starts after stop()", async () => {
    let calls = 0;
    const scheduler = createScheduler({
      intervalMs: 10,
      firstDelayMs: 0,
      pass: async () => {
        calls++;
      },
      onError: () => {},
    });
    await sleep(60);
    scheduler.stop();
    const at = calls;
    await sleep(80);
    expect(calls).toBe(at);
  });
});

describe("what a log may say about an error", () => {
  it("is the kind of error, never its message", () => {
    const error = Object.assign(new Error('relation "x" failed with password=hunter2'), { code: "P2022" });
    error.name = "PrismaClientKnownRequestError";
    const text = describeError(error);
    expect(text).toBe("PrismaClientKnownRequestError P2022");
    expect(text).not.toContain("hunter2");
    expect(describeError("a string with a secret")).toBe("unknown error");
  });
});
