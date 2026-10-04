import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Scratch files are not indexed, and a day's embedding allowance is spent on
 * purpose: past it, files wait for the next day instead of failing.
 */

vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

const drive = vi.hoisted(() => ({ files: [] as Array<Record<string, unknown>> }));
vi.mock("@/lib/drive", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/drive")>();
  return {
    ...actual,
    listTree: vi.fn(async () => ({ files: drive.files, folders: ["folder1"], truncated: false })),
    readFileText: vi.fn(async () => ({ ok: true, text: "some text to index" })),
  };
});
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
const { env } = await import("@/lib/env");
const { GOOGLE_DRIVE_CREDENTIAL } = await import("@/lib/google-oauth");
const { isTemporaryName } = await import("@/lib/drive");
const { syncSource } = await import("@/server/knowledge/indexer");
const { runKnowledgeJobs } = await import("@/server/knowledge/worker");
const { quotaDayStart, fits } = await import("@/server/knowledge/embedding-budget");
const { seedInstallation } = await import("./knowledge-fixtures");

const file = (id: string, over: Record<string, unknown> = {}) => ({
  id, name: `${id}.txt`, mimeType: "text/plain", revision: "r1", webUrl: null, path: "", size: 5, ...over,
});

const setLimit = (n: number) => {
  (env.embeddings as { dailyLimit: number }).dailyLimit = n;
};

let sourceId = "";

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

beforeEach(async () => {
  setLimit(0);
  await wipe();
  drive.files = [];
  await prisma.plan.create({
    data: { id: "q", name: "Q", monthlyRuns: 1, storageBytes: BigInt(1), monthlyCredits: 0, knowledgeSources: 1, knowledgeFiles: 10 },
  });
  const user = await prisma.user.create({
    data: { email: "q@example.test", name: "Q", passwordHash: "x", initials: "Q", planId: "q" },
  });
  const account = await prisma.connectedAccount.create({
    data: { userId: user.id, credentialType: GOOGLE_DRIVE_CREDENTIAL, displayName: "Google Drive", initials: "GD", accountRef: "q@example.test", status: "ACTIVE" },
  });
  const installation = await seedInstallation(user.id);
  sourceId = (
    await prisma.knowledgeSource.create({
      data: { userId: user.id, installationId: installation.id, accountId: account.id, folderId: "folder1", folderName: "F", status: "ACTIVE" },
    })
  ).id;
});
afterAll(async () => {
  setLimit(0);
  await wipe();
  await prisma.$disconnect();
});

describe("scratch files", () => {
  it("recognises them by name", () => {
    expect(isTemporaryName("tmp_ocr_report")).toBe(true);
    expect(isTemporaryName("TMP_x.pdf")).toBe(true);
    expect(isTemporaryName("~$budget.docx")).toBe(true);
    expect(isTemporaryName("draft.tmp")).toBe(true);
    expect(isTemporaryName("template.pdf")).toBe(false);
    expect(isTemporaryName("my_tmp_notes.txt")).toBe(false);
  });

  it("are listed as skipped, never queued, and do not use the plan's file allowance", async () => {
    drive.files = [file("a", { name: "tmp_ocr_a" }), file("b")];
    await syncSource(sourceId);
    const a = await prisma.knowledgeFile.findFirstOrThrow({ where: { externalId: "a" } });
    expect(a).toMatchObject({ status: "UNSUPPORTED", error: expect.stringMatching(/temporary/i) });
    expect(await prisma.knowledgeJob.count()).toBe(1);
  });

  it("drops a scratch file that was already waiting or indexed", async () => {
    drive.files = [file("a", { name: "report.txt" })];
    await syncSource(sourceId);
    await runKnowledgeJobs({ log: () => {} });
    expect((await prisma.knowledgeFile.findFirstOrThrow()).status).toBe("READY");
    expect(await prisma.knowledgeChunk.count()).toBeGreaterThan(0);

    drive.files = [file("a", { name: "tmp_report.txt" })];
    await syncSource(sourceId);
    expect(await prisma.knowledgeFile.findFirstOrThrow()).toMatchObject({ status: "UNSUPPORTED", chunkCount: 0 });
    expect(await prisma.knowledgeChunk.count()).toBe(0);
  });
});

describe("the daily embedding allowance", () => {
  it("finds the start of the Pacific day, in summer and in winter time", () => {
    expect(quotaDayStart(new Date("2026-10-02T12:00:00Z")).toISOString()).toBe("2026-10-02T07:00:00.000Z");
    expect(quotaDayStart(new Date("2026-10-02T03:00:00Z")).toISOString()).toBe("2026-10-01T07:00:00.000Z");
    expect(quotaDayStart(new Date("2026-12-02T12:00:00Z")).toISOString()).toBe("2026-12-02T08:00:00.000Z");
  });

  it("lets a file through only if it fits, or can never fit", () => {
    const room = (used: number) => ({ limit: 10, used, remaining: 10 - used, secondsToReset: 100 });
    expect(fits(room(8), 2)).toBe(true);
    expect(fits(room(8), 3)).toBe(false);
    expect(fits(room(0), 50)).toBe(true);
    expect(fits(room(1), 50)).toBe(false);
    expect(fits({ limit: 0, used: 0, remaining: Infinity, secondsToReset: 1 }, 1e6)).toBe(true);
  });

  it("holds files back once it is spent: waiting, not failed, no attempt used up", async () => {
    setLimit(2);
    drive.files = [file("a"), file("b"), file("c")];
    await syncSource(sourceId);
    const summary = await runKnowledgeJobs({ log: () => {} });
    expect(summary.failed).toBe(0);

    const files = await prisma.knowledgeFile.findMany({ orderBy: { externalId: "asc" } });
    expect(files.filter((f) => f.status === "READY")).toHaveLength(2);
    const waiting = files.filter((f) => f.status === "PENDING");
    expect(waiting).toHaveLength(1);
    expect(waiting[0].error).toMatch(/allowance is used up/i);

    const job = await prisma.knowledgeJob.findFirstOrThrow();
    expect(job.attempts).toBe(0);
    expect(job.runAfter.getTime()).toBeGreaterThan(Date.now() + 60_000);
    expect(job.leasedUntil).toBeNull();
  });

  it("does nothing of its own when no limit is set", async () => {
    drive.files = [file("a"), file("b"), file("c")];
    await syncSource(sourceId);
    await runKnowledgeJobs({ log: () => {} });
    expect(await prisma.knowledgeFile.count({ where: { status: "READY" } })).toBe(3);
  });
});
