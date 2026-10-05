import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Gemini's 429: reading what it says about the wait, waiting out a short
 * per-minute limit inside the call, leaving a long or daily one to the queue —
 * and the queue giving a rate limit more, and longer, chances than an ordinary
 * failure, because the two files that stayed Failed on the deployed platform
 * were never broken, only too early for a quota that refills.
 */

const { prisma } = await import("@/lib/db");
const { env } = await import("@/lib/env");
const embeddings = await import("@/lib/embeddings");
const { classifyJobError, friendlyJobError, retryInfoOf } = await import("@/server/knowledge/errors");
const queue = await import("@/server/knowledge/queue");
const { runKnowledgeJobs } = await import("@/server/knowledge/worker");
const { SourceStatus } = await import("@/app/(app)/workspace/[installationId]/files/parts");

const { EmbeddingError, embedTexts, embeddingsRuntime, readRateLimit } = embeddings;

function limited(headers: Record<string, string> = {}, body: unknown = {}) {
  return new Response(JSON.stringify(body), { status: 429, headers });
}
const ok = (n: number) =>
  new Response(JSON.stringify({ embeddings: Array.from({ length: n }, () => ({ values: new Array(768).fill(0.1) })) }), {
    status: 200,
  });

describe("readRateLimit", () => {
  it("reads Retry-After", async () => {
    expect(await readRateLimit(limited({ "retry-after": "17" }))).toEqual({ retryAfterSeconds: 17, quota: undefined });
  });

  it("reads Gemini's RetryInfo and tells a per-minute limit from a per-day one", async () => {
    const minute = limited({}, {
      error: { details: [
        { "@type": "type.googleapis.com/google.rpc.QuotaFailure", violations: [{ quotaId: "EmbedContentRequestsPerMinutePerProjectPerModel-FreeTier" }] },
        { "@type": "type.googleapis.com/google.rpc.RetryInfo", retryDelay: "34s" },
      ] },
    });
    expect(await readRateLimit(minute)).toEqual({ retryAfterSeconds: 34, quota: "minute" });

    const day = limited({}, {
      error: { details: [{ violations: [{ quotaId: "EmbedContentRequestsPerDayPerProjectPerModel-FreeTier" }] }] },
    });
    expect((await readRateLimit(day)).quota).toBe("day");
  });

  it("copes with a body that is not JSON", async () => {
    expect(await readRateLimit(new Response("<html>nope</html>", { status: 429 }))).toEqual({
      retryAfterSeconds: undefined,
      quota: undefined,
    });
  });
});

describe("embedTexts against Gemini", () => {
  const driver = env.embeddings.driver;
  const key = env.embeddings.apiKey;
  const sleeps: number[] = [];
  const realSleep = embeddingsRuntime.sleep;

  beforeEach(() => {
    (env.embeddings as { driver: string }).driver = "gemini";
    (env.embeddings as { apiKey: string }).apiKey = "test-key";
    sleeps.length = 0;
    embeddingsRuntime.sleep = async (ms) => {
      sleeps.push(ms);
    };
  });
  afterEach(() => {
    (env.embeddings as { driver: string }).driver = driver;
    (env.embeddings as { apiKey: string }).apiKey = key;
    embeddingsRuntime.sleep = realSleep;
    vi.unstubAllGlobals();
  });

  it("waits out a short per-minute limit itself and carries on, without throwing the file back", async () => {
    const replies = [limited({ "retry-after": "4" }), ok(3)];
    vi.stubGlobal("fetch", vi.fn(async () => replies.shift()!));
    const vectors = await embedTexts(["a", "b", "c"], "document");
    expect(vectors).toHaveLength(3);
    expect(sleeps).toEqual([4000]);
  });

  it("waits less for a question's embedding than for a file's, since a person is waiting", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => limited({ "retry-after": "12" })));
    const error = await embedTexts(["q"], "query").catch((e) => e);
    expect(error).toBeInstanceOf(EmbeddingError);
    expect(sleeps).toEqual([]);

    const replies = [limited({ "retry-after": "12" }), ok(1)];
    vi.stubGlobal("fetch", vi.fn(async () => replies.shift()!));
    expect(await embedTexts(["d"], "document")).toHaveLength(1);
    expect(sleeps).toEqual([12000]);
  });

  it("gives up inside the call on a daily limit, with the quota named, and does not wait", async () => {
    vi.stubGlobal("fetch", vi.fn(async () =>
      limited({}, { error: { details: [{ violations: [{ quotaId: "EmbedContentRequestsPerDayPerProjectPerModel" }] }] } }),
    ));
    const error = await embedTexts(["a"], "document").catch((e) => e);
    expect(error).toBeInstanceOf(EmbeddingError);
    expect(error.limit.quota).toBe("day");
    expect(sleeps).toEqual([]);
  });

  it("hands a long wait to the queue instead of sleeping on it, keeping what the API asked for", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => limited({ "retry-after": "90" })));
    const error = await embedTexts(["a"], "document").catch((e) => e);
    expect(error.limit.retryAfterSeconds).toBe(90);
    expect(sleeps).toEqual([]);
  });

  it("never waits more than a few times, or for long, inside one call", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => limited({ "retry-after": "10" })));
    await embedTexts(["a"], "document").catch(() => {});
    expect(sleeps.reduce((a, b) => a + b, 0)).toBeLessThanOrEqual(25_000);
    expect(sleeps.length).toBeLessThanOrEqual(3);
  });

  it("does not wait on other failures", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("{}", { status: 400 })));
    await expect(embedTexts(["a"], "document")).rejects.toMatchObject({ retryable: false });
    expect(sleeps).toEqual([]);
  });

  it("sends at most 25 texts per request", async () => {
    const sizes: number[] = [];
    vi.stubGlobal("fetch", vi.fn(async (_u: string, init: RequestInit) => {
      const n = JSON.parse(String(init.body)).requests.length;
      sizes.push(n);
      return ok(n);
    }));
    await embedTexts(Array.from({ length: 60 }, (_, i) => `t${i}`), "document");
    expect(sizes).toEqual([25, 25, 10]);
  });
});

describe("how the queue treats a rate limit", () => {
  it("backs off from a minute to an hour, never sooner than the API said", () => {
    const delays = [1, 2, 3, 4, 5, 6, 7, 8].map((n) => queue.retryDelaySeconds(n, { rateLimited: true }));
    expect(delays).toEqual([60, 120, 240, 480, 960, 1920, 3600, 3600]);
    expect(queue.retryDelaySeconds(1, { rateLimited: true, retryAfterSeconds: 300 })).toBe(300);
    expect(queue.retryDelaySeconds(1, { rateLimited: true, retryAfterSeconds: 99_999 })).toBe(3600);
  });

  it("leaves an ordinary failure on the old schedule", () => {
    expect([1, 2, 3, 4].map((n) => queue.retryDelaySeconds(n))).toEqual([30, 120, 480, 1920]);
    expect(queue.maxAttemptsFor()).toBe(5);
    expect(queue.maxAttemptsFor({ rateLimited: true })).toBe(12);
  });

  it("recognises a rate limit and the wait it asked for", () => {
    expect(retryInfoOf(new EmbeddingError("Embedding API answered 429.", true, { retryAfterSeconds: 12 }))).toEqual({
      rateLimited: true,
      retryAfterSeconds: 12,
    });
    expect(retryInfoOf(new EmbeddingError("Embedding API answered 503.", true))).toEqual({});
    expect(classifyJobError(new EmbeddingError("Embedding API answered 429.", true))).toBe("embeddings_rate_limit");
  });
});

describe("a rate-limited file in the worker", () => {
  const PLAN = "rl-plan";
  async function wipe() {
    await prisma.knowledgeJob.deleteMany({});
    await prisma.knowledgeChunk.deleteMany({});
    await prisma.knowledgeFile.deleteMany({});
    await prisma.knowledgeSource.deleteMany({});
    await prisma.installation.deleteMany({});
    await prisma.product.deleteMany({});
    await prisma.connectedAccount.deleteMany({});
    await prisma.user.deleteMany({});
    await prisma.plan.deleteMany({});
  }
  afterAll(async () => {
    await wipe();
    await prisma.$disconnect();
  });

  async function seed() {
    await wipe();
    const { seedInstallation } = await import("./knowledge-fixtures");
    await prisma.plan.create({ data: { id: PLAN, name: "T", monthlyRuns: 1, storageBytes: BigInt(1), monthlyCredits: 0 } });
    const user = await prisma.user.create({ data: { email: "r@example.test", name: "R", passwordHash: "x", initials: "R", planId: PLAN } });
    const installation = await seedInstallation(user.id);
    const account = await prisma.connectedAccount.create({
      data: { userId: user.id, credentialType: "googleDriveOAuth2Api", displayName: "G", initials: "G", accountRef: "r@example.test", status: "ACTIVE" },
    });
    const source = await prisma.knowledgeSource.create({
      data: { userId: user.id, installationId: installation.id, accountId: account.id, folderId: "f", folderName: "F", lastSyncedAt: new Date() },
    });
    return prisma.knowledgeFile.create({
      data: { sourceId: source.id, externalId: "e", name: "big.pdf", mimeType: "text/plain", revision: "r" },
    });
  }

  it("is retried far beyond five attempts, says why in plain words, and only then gives up", async () => {
    vi.resetModules();
    vi.doMock("@/server/google-account", () => ({ getGoogleAccessToken: async () => "t", saveGoogleConnection: vi.fn() }));
    vi.doMock("@/server/knowledge/watch", () => ({ ensureWatch: vi.fn(), renewWatches: vi.fn(async () => ({})), stopWatch: vi.fn() }));
    vi.doMock("@/lib/drive", async (orig) => ({
      ...(await orig<typeof import("@/lib/drive")>()),
      readFileText: async () => ({ ok: true, text: "some text" }),
    }));
    vi.doMock("@/lib/embeddings", async (orig) => {
      const actual = await orig<typeof import("@/lib/embeddings")>();
      return {
        ...actual,
        embedTexts: async () => {
          throw new actual.EmbeddingError("Embedding API answered 429.", true, { retryAfterSeconds: 7 });
        },
      };
    });
    const q = await import("@/server/knowledge/queue");
    const w = await import("@/server/knowledge/worker");
    const { prisma: db } = await import("@/lib/db");
    const file = await seed();
    await q.enqueue("INDEX_FILE", file.id);

    const lines: string[] = [];
    for (let attempt = 1; attempt <= 11; attempt++) {
      await db.knowledgeJob.updateMany({ data: { runAfter: new Date(Date.now() - 1000) } });
      const summary = await w.runKnowledgeJobs({ log: (l) => lines.push(l) });
      expect(summary.gaveUp, `attempt ${attempt}`).toBe(0);
    }
    const waiting = await db.knowledgeFile.findUniqueOrThrow({ where: { id: file.id } });
    expect(waiting.status).toBe("PENDING");
    expect(waiting.error).toBe("The embedding service is limiting requests (rate limit or daily quota). Retrying automatically.");
    expect(lines.some((l) => l.includes("attempt=11/12"))).toBe(true);

    await db.knowledgeJob.updateMany({ data: { runAfter: new Date(Date.now() - 1000) } });
    const last = await w.runKnowledgeJobs({ log: (l) => lines.push(l) });
    expect(last.gaveUp).toBe(1);
    const failed = await db.knowledgeFile.findUniqueOrThrow({ where: { id: file.id } });
    expect(failed.status).toBe("FAILED");
    expect(failed.error).toMatch(/Press Retry later/);
    expect(failed.error).not.toMatch(/429/);
    vi.doUnmock("@/lib/embeddings");
    vi.doUnmock("@/lib/drive");
    void runKnowledgeJobs;
  });
});

describe("friendlyJobError", () => {
  it("says what happened in words, with no status codes", () => {
    for (const type of ["embeddings_rate_limit", "embeddings_server_error", "drive_rate_limit"]) {
      for (const gaveUp of [true, false]) expect(friendlyJobError(type, gaveUp)).not.toMatch(/\b(429|5\d\d)\b/);
    }
    expect(friendlyJobError("something_else", false)).toBe("Retrying after a temporary problem.");
    expect(friendlyJobError("something_else", true)).toBeNull();
  });
});

describe("the folder badge", () => {
  const text = (node: unknown): string => JSON.stringify(node);
  it("does not say 'Up to date' when files failed", () => {
    expect(text(SourceStatus({ status: "ACTIVE", busy: false, failed: 2 }))).toContain("failed");
    expect(text(SourceStatus({ status: "ACTIVE", busy: false, failed: 2 }))).not.toContain("Up to date");
  });
  it("says it when nothing failed, and Syncing while work is in flight", () => {
    expect(text(SourceStatus({ status: "ACTIVE", busy: false, failed: 0 }))).toContain("Up to date");
    expect(text(SourceStatus({ status: "ACTIVE", busy: true, failed: 2 }))).toContain("Syncing");
  });
});
