import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * "Syncing" that never ends because nothing is running the queue: the heartbeat
 * that tells that apart from a slow queue, the alert decision built on it, and the
 * operator's status endpoint. The page itself is a thin read of these.
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
const { GOOGLE_DRIVE_CREDENTIAL } = await import("@/lib/google-oauth");
const heartbeat = await import("@/server/knowledge/heartbeat");
const { runKnowledgeJobs } = await import("@/server/knowledge/worker");
const { enqueue } = await import("@/server/knowledge/queue");
const { POST: tick } = await import("@/app/api/knowledge/tick/route");
const { GET: status } = await import("@/app/api/knowledge/status/route");
const { seedInstallation } = await import("./knowledge-fixtures");

const { TICK, isStalled, queueHealth, processingStalled, recordTick } = heartbeat;
const PLAN = "test-plan-heartbeat";

async function wipe() {
  await prisma.heartbeat.deleteMany({});
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

async function seedSource(email: string) {
  const user = await prisma.user.create({
    data: { email, name: email, passwordHash: "x", initials: "U", planId: PLAN },
  });
  const installation = await seedInstallation(user.id);
  const account = await prisma.connectedAccount.create({
    data: { userId: user.id, credentialType: GOOGLE_DRIVE_CREDENTIAL, displayName: "G", initials: "G", accountRef: email, status: "ACTIVE" },
  });
  return prisma.knowledgeSource.create({
    data: { userId: user.id, installationId: installation.id, accountId: account.id, folderId: `f-${email}`, folderName: "F" },
  });
}

const ageTick = (seconds: number) =>
  prisma.$executeRaw`UPDATE "Heartbeat" SET at = now() - make_interval(secs => ${seconds}) WHERE name = ${TICK}`;
const ageJobs = (seconds: number) =>
  prisma.$executeRaw`UPDATE "KnowledgeJob" SET "runAfter" = now() - make_interval(secs => ${seconds})`;

beforeEach(async () => {
  await wipe();
  await prisma.plan.create({
    data: { id: PLAN, name: "T", monthlyRuns: 1, storageBytes: BigInt(1), monthlyCredits: 0 },
  });
});
afterAll(async () => {
  await wipe();
  await prisma.$disconnect();
});

describe("recordTick", () => {
  it("leaves a timestamp, and does not rewrite it on every pass of a busy worker", async () => {
    await recordTick();
    const first = await queueHealth();
    expect(first.lastTickAgeSeconds).toBeLessThan(5);

    await ageTick(5); // 5 s old: within the write-throttle window
    await recordTick();
    expect((await queueHealth()).lastTickAgeSeconds).toBeGreaterThanOrEqual(5);

    await ageTick(60); // old enough to be worth refreshing
    await recordTick();
    expect((await queueHealth()).lastTickAgeSeconds).toBeLessThan(5);
  });

  it("is recorded by every drain pass, and by the tick endpoint — but not by a refused call", async () => {
    await runKnowledgeJobs();
    expect(await prisma.heartbeat.count()).toBe(1);

    await prisma.heartbeat.deleteMany({});
    const refused = await tick(new Request("https://app.example.test/api/knowledge/tick", { method: "POST" }));
    expect(refused.status).toBe(401);
    expect(await prisma.heartbeat.count()).toBe(0);

    const ok = await tick(
      new Request("https://app.example.test/api/knowledge/tick", {
        method: "POST",
        headers: { "x-schedule-token": process.env.SCHEDULE_TOKEN! },
      }),
    );
    expect(ok.status).toBe(200);
    expect(await prisma.heartbeat.count()).toBe(1);
  });
});

describe("isStalled", () => {
  it("needs both: work waiting and no recent tick", () => {
    expect(isStalled({ lastTickAgeSeconds: null, waitingTooLong: 3 })).toBe(true);
    expect(isStalled({ lastTickAgeSeconds: 600, waitingTooLong: 1 })).toBe(true);
    expect(isStalled({ lastTickAgeSeconds: 30, waitingTooLong: 5 })).toBe(false); // alive, just a backlog
    expect(isStalled({ lastTickAgeSeconds: null, waitingTooLong: 0 })).toBe(false); // idle, nothing to do
    expect(isStalled({ lastTickAgeSeconds: 600, waitingTooLong: 0 })).toBe(false);
  });
});

describe("processingStalled", () => {
  it("is quiet in the normal case: the worker is ticking, jobs are being picked up", async () => {
    const s = await seedSource("a@example.test");
    await enqueue("SYNC_SOURCE", s.id);
    await ageJobs(600);
    await recordTick();
    expect(await processingStalled([s.id])).toBe(false);
  });

  it("is quiet for a brand-new job even if nothing has ticked yet", async () => {
    const s = await seedSource("a@example.test");
    await enqueue("SYNC_SOURCE", s.id);
    expect(await processingStalled([s.id])).toBe(false);
  });

  it("raises when a job has waited past the threshold and there has never been a tick", async () => {
    const s = await seedSource("a@example.test");
    await enqueue("SYNC_SOURCE", s.id);
    await ageJobs(300);
    expect(await processingStalled([s.id])).toBe(true);
  });

  it("raises when the last tick is old too, and clears once a tick arrives", async () => {
    const s = await seedSource("a@example.test");
    await enqueue("SYNC_SOURCE", s.id);
    await ageJobs(300);
    await recordTick();
    await ageTick(900);
    expect(await processingStalled([s.id])).toBe(true);
    await ageTick(1);
    expect(await processingStalled([s.id])).toBe(false);
  });

  it("counts the indexing jobs of a user's files, not just their syncs", async () => {
    const s = await seedSource("a@example.test");
    const file = await prisma.knowledgeFile.create({
      data: { sourceId: s.id, externalId: "x", name: "n", mimeType: "text/plain", revision: "r" },
    });
    await enqueue("INDEX_FILE", file.id);
    await ageJobs(300);
    expect(await processingStalled([s.id])).toBe(true);
  });

  it("ignores jobs that are being worked on, backing off, or someone else's", async () => {
    const mine = await seedSource("mine@example.test");
    const theirs = await seedSource("theirs@example.test");

    await enqueue("SYNC_SOURCE", mine.id);
    await ageJobs(300);
    await prisma.$executeRaw`UPDATE "KnowledgeJob" SET "leasedUntil" = now() + interval '5 minutes'`;
    expect(await processingStalled([mine.id])).toBe(false); // leased: a worker has it

    await prisma.$executeRaw`UPDATE "KnowledgeJob" SET "leasedUntil" = NULL, "runAfter" = now() + interval '5 minutes'`;
    expect(await processingStalled([mine.id])).toBe(false); // backing off after a failure

    await enqueue("SYNC_SOURCE", theirs.id);
    await ageJobs(300);
    expect(await processingStalled([mine.id])).toBe(true); // both are stale now
    await prisma.knowledgeJob.deleteMany({ where: { targetId: mine.id } });
    expect(await processingStalled([mine.id])).toBe(false); // theirs is not mine
    expect(await processingStalled([theirs.id])).toBe(true);
  });

  it("says nothing when there are no folders", async () => {
    expect(await processingStalled([])).toBe(false);
  });
});

describe("GET /api/knowledge/status", () => {
  const get = (token?: string) =>
    status(
      new Request("https://app.example.test/api/knowledge/status", {
        headers: token ? { "x-schedule-token": token } : {},
      }),
    );

  it("is refused without the schedule token", async () => {
    expect((await get()).status).toBe(401);
    expect((await get("wrong")).status).toBe(401);
  });

  it("reports pgvector, configuration, the last tick and the queue — and no secret", async () => {
    await recordTick();
    const res = await get(process.env.SCHEDULE_TOKEN);
    const text = await res.text();
    const body = JSON.parse(text);
    expect(res.status).toBe(200);
    expect(body.database.pgvector).toBe(true);
    expect(body.google).toEqual({ configured: true, missing: [] });
    expect(body.tick.lastAgeSeconds).toBeLessThan(5);
    expect(body.queue).toEqual({ waitingTooLong: 0, stalled: false });
    expect(body.ok).toBe(true);
    for (const secret of [process.env.GOOGLE_CLIENT_SECRET!, process.env.SCHEDULE_TOKEN!, process.env.SECRETS_KEY!]) {
      expect(text).not.toContain(secret);
    }
  });

  it("says stalled when work is waiting and nothing has ticked", async () => {
    const s = await seedSource("a@example.test");
    await enqueue("SYNC_SOURCE", s.id);
    await ageJobs(600);
    const body = await (await get(process.env.SCHEDULE_TOKEN)).json();
    expect(body.queue).toEqual({ waitingTooLong: 1, stalled: true });
    expect(body.tick.lastAgeSeconds).toBeNull();
    expect(body.ok).toBe(false);
  });

  it("names a missing Google setting, never its value", async () => {
    const saved = { id: process.env.GOOGLE_CLIENT_ID, key: process.env.SECRETS_KEY };
    delete process.env.GOOGLE_CLIENT_ID;
    process.env.SECRETS_KEY = "not-64-hex-characters";
    try {
      vi.resetModules();
      const fresh = await import("@/app/api/knowledge/status/route");
      const res = await fresh.GET(
        new Request("https://app.example.test/api/knowledge/status", {
          headers: { "x-schedule-token": process.env.SCHEDULE_TOKEN! },
        }),
      );
      const text = await res.text();
      expect(JSON.parse(text).google).toEqual({
        configured: false,
        missing: ["GOOGLE_CLIENT_ID", "SECRETS_KEY"],
      });
      expect(text).not.toContain("not-64-hex-characters");
      expect(text).not.toContain(process.env.GOOGLE_CLIENT_SECRET!);
    } finally {
      process.env.GOOGLE_CLIENT_ID = saved.id;
      process.env.SECRETS_KEY = saved.key;
      vi.resetModules();
    }
  });
});
