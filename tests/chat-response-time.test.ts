import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Chat reply latency, simulated: n8n.chat is mocked to answer after a fake-timer
 * delay, and the elapsed (fake) time from asking to the stored reply is measured.
 * Only setTimeout/Date are faked so the real Postgres I/O still runs.
 */

const FALLBACK = "Something went wrong reaching the assistant. Please try again in a moment.";

const chat = vi.hoisted(() => ({
  calls: [] as { timeoutMs?: number }[],
  /** Called for each attempt; returns the promise the mocked n8n.chat gives back. */
  behave: null as null | ((attempt: number) => Promise<{ output: string }>),
}));

vi.mock("next/server", async (importOriginal) => ({
  ...(await importOriginal<typeof import("next/server")>()),
  after: (work: () => unknown) => work(),
}));
vi.mock("@/lib/n8n", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/n8n")>();
  return {
    ...actual,
    n8n: {
      ...actual.n8n,
      chat: (_input: unknown, options?: { timeoutMs?: number }) => {
        chat.calls.push({ timeoutMs: options?.timeoutMs });
        return chat.behave!(chat.calls.length - 1);
      },
    },
  };
});

const { prisma } = await import("@/lib/db");
const { answerThread } = await import("@/server/thread-reply");
const { askOrchestrator } = await import("@/server/run-engine");
const { MAX_AVG_REPLY_MS, MAX_REPLY_MS, assertReplyLatency } = await import("@/lib/reply-latency");

const after = (ms: number, output = "ok") =>
  new Promise<{ output: string }>((resolve) => setTimeout(() => resolve({ output }), ms));
const failAfter = (ms: number) =>
  new Promise<{ output: string }>((_, reject) => setTimeout(() => reject(new Error("boom")), ms));
const never = () => new Promise<{ output: string }>(() => {});

async function wipe() {
  await prisma.message.deleteMany({});
  await prisma.thread.deleteMany({});
  await prisma.user.deleteMany({});
  await prisma.plan.deleteMany({});
}

let userId = "";
let threadId = "";

beforeEach(async () => {
  vi.useRealTimers();
  await wipe();
  chat.calls.length = 0;
  await prisma.plan.create({
    data: { id: "lat", name: "L", monthlyRuns: 1, storageBytes: BigInt(1), monthlyCredits: 0 },
  });
  const user = await prisma.user.create({
    data: { email: "lat@example.test", name: "L", passwordHash: "x", initials: "L", planId: "lat" },
  });
  userId = user.id;
  threadId = (await prisma.thread.create({ data: { userId, title: "t" } })).id;
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

afterAll(async () => {
  await wipe();
  await prisma.$disconnect();
});

/** Waits (real I/O) until the mocked chat has been called `n` times. */
async function chatCalled(n: number) {
  for (let i = 0; i < 500 && chat.calls.length < n; i++) {
    await vi.advanceTimersByTimeAsync(0);
    await new Promise((resolve) => setImmediate(resolve));
  }
  expect(chat.calls.length).toBeGreaterThanOrEqual(n);
}

/** Runs one reply and returns the simulated time it took. */
async function timedReply(totalAdvanceMs: number) {
  const started = Date.now();
  const done = answerThread(userId, threadId, "hello");
  await chatCalled(1);
  await vi.advanceTimersByTimeAsync(totalAdvanceMs);
  await done;
  return Date.now() - started;
}

const lastReply = async () =>
  (await prisma.message.findFirstOrThrow({ where: { role: "ASSISTANT" }, orderBy: { createdAt: "desc" } })).body;

describe("a single reply", () => {
  it.each([5_000, 90_000, 179_000])("stores a reply that n8n takes %i ms to give", async (delay) => {
    chat.behave = () => after(delay, "slow answer");
    const elapsed = await timedReply(delay);
    expect(elapsed).toBeLessThanOrEqual(MAX_REPLY_MS);
    expect(await lastReply()).toBe("slow answer");
  });

  it("gives chat the whole budget as its timeout", async () => {
    chat.behave = () => after(1);
    await timedReply(1);
    expect(chat.calls[0].timeoutMs).toBe(MAX_REPLY_MS);
  });

  it("stores the fallback by 180 s when n8n never answers", async () => {
    chat.behave = never;
    const elapsed = await timedReply(MAX_REPLY_MS);
    expect(elapsed).toBeLessThanOrEqual(MAX_REPLY_MS);
    expect(await lastReply()).toBe(FALLBACK);
  });
});

describe("the retry budget", () => {
  it("does not retry when the first attempt fails at 170 s", async () => {
    chat.behave = () => failAfter(170_000);
    const started = Date.now();
    const done = askOrchestrator(userId, "hi", threadId);
    await chatCalled(1);
    await vi.advanceTimersByTimeAsync(MAX_REPLY_MS);
    expect(await done).toBe(FALLBACK);
    expect(chat.calls).toHaveLength(1);
    expect(Date.now() - started).toBeLessThanOrEqual(MAX_REPLY_MS);
  });

  it("still retries after a quick failure, with only the remaining time", async () => {
    chat.behave = (attempt) => (attempt === 0 ? failAfter(1_000) : after(1_000, "second try"));
    const done = askOrchestrator(userId, "hi", threadId);
    await chatCalled(1);
    await vi.advanceTimersByTimeAsync(1_000 + 4_000);
    await chatCalled(2);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(await done).toBe("second try");
    expect(chat.calls[1].timeoutMs).toBe(MAX_REPLY_MS - 5_000);
  });
});

describe("average reply time", () => {
  it("stays within 2 minutes for a fixed set of conversations", async () => {
    const delays = [10_000, 30_000, 60_000, 120_000, 150_000];
    const samples: number[] = [];
    for (const delay of delays) {
      chat.calls.length = 0;
      chat.behave = () => after(delay);
      samples.push(await timedReply(delay));
    }
    const summary = assertReplyLatency(samples);
    expect(summary.avgMs).toBe(74_000);
    expect(summary.avgMs).toBeLessThanOrEqual(MAX_AVG_REPLY_MS);
  });

  it("is flagged when the delays average above 2 minutes", () => {
    expect(() => assertReplyLatency([100_000, 150_000, 170_000])).toThrow(/Average/);
  });
});
