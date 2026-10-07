import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The knowledge pipeline against real Postgres with pgvector: queue semantics,
 * syncing a folder, indexing a file into searchable chunks, and how each kind of
 * failure is handled. Drive itself is stubbed at the module boundary.
 */

const drive = vi.hoisted(() => ({
  files: [] as Array<Record<string, unknown>>,
  truncated: false,
  texts: {} as Record<string, string>,
  failList: null as unknown,
  failRead: {} as Record<string, unknown>,
}));

vi.mock("@/lib/drive", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/drive")>();
  return {
    ...actual,
    listTree: vi.fn(async () => {
      if (drive.failList) throw drive.failList;
      return { files: drive.files, folders: ["folder1"], truncated: drive.truncated };
    }),
    readFileText: vi.fn(async (_t: string, file: { id: string }) => {
      if (drive.failRead[file.id]) throw drive.failRead[file.id];
      const text = drive.texts[file.id];
      return text === undefined ? { ok: false, reason: "The file is empty." } : { ok: true, text };
    }),
    getFolder: vi.fn(async (_t: string, id: string) => ({ id, name: "Contracts" })),
  };
});
vi.mock("@/server/knowledge/watch", () => ({ ensureWatch: vi.fn(async () => {}), renewWatches: vi.fn(async () => ({ renewed: 0, failed: 0 })) }));
vi.mock("@/server/google-account", () => ({
  getGoogleAccessToken: vi.fn(async () => "token"),
  saveGoogleConnection: vi.fn(),
}));

const { prisma } = await import("@/lib/db");
const { DriveError } = await import("@/lib/drive");
const { GoogleAuthError, GOOGLE_DRIVE_CREDENTIAL } = await import("@/lib/google-oauth");
const { embedTexts, toVectorLiteral } = await import("@/lib/embeddings");
const queue = await import("@/server/knowledge/queue");
const { syncSource, indexFile } = await import("@/server/knowledge/indexer");
const { runKnowledgeJobs, enqueueDueSyncs } = await import("@/server/knowledge/worker");
const { createKnowledgeSource } = await import("@/server/knowledge/sources");
const { resumeKnowledgeSources } = await import("@/server/knowledge/resume");
const { getGoogleAccessToken } = await import("@/server/google-account");
const { ensureWatch } = await import("@/server/knowledge/watch");

const { seedInstallation } = await import("./knowledge-fixtures");

const PLAN_ID = "test-plan-knowledge";
let installationId = "";
let userId = "";
let accountId = "";
let sourceId = "";

function file(id: string, over: Record<string, unknown> = {}) {
  return {
    id,
    name: `${id}.txt`,
    mimeType: "text/plain",
    revision: "r1",
    webUrl: `https://drive.example/${id}`,
    path: "",
    size: 10,
    ...over,
  };
}

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
  await wipe();
  drive.files = [];
  drive.truncated = false;
  drive.texts = {};
  drive.failList = null;
  drive.failRead = {};
  vi.mocked(getGoogleAccessToken).mockResolvedValue("token");

  await prisma.plan.create({
    data: { id: PLAN_ID, name: "T", monthlyRuns: 1, storageBytes: BigInt(1), monthlyCredits: 0 },
  });
  const user = await prisma.user.create({
    data: { email: "o@example.test", name: "O", passwordHash: "x", initials: "O", planId: PLAN_ID },
  });
  userId = user.id;
  const account = await prisma.connectedAccount.create({
    data: {
      userId,
      credentialType: GOOGLE_DRIVE_CREDENTIAL,
      displayName: "Google Drive",
      initials: "GD",
      accountRef: "o@example.test",
      status: "ACTIVE",
    },
  });
  accountId = account.id;
  installationId = (await seedInstallation(userId)).id;
  const source = await prisma.knowledgeSource.create({
    data: { userId, installationId, accountId, folderId: "folder1", folderName: "Contracts" },
  });
  sourceId = source.id;
});

afterAll(async () => {
  await wipe();
  await prisma.$disconnect();
});

const jobCount = () => prisma.knowledgeJob.count();

describe("queue", () => {
  it("collapses repeated requests into one pending job", async () => {
    await queue.enqueue("SYNC_SOURCE", sourceId);
    await queue.enqueue("SYNC_SOURCE", sourceId);
    expect(await jobCount()).toBe(1);
  });

  it("hands a job to exactly one of several concurrent claimers", async () => {
    await queue.enqueue("SYNC_SOURCE", sourceId);
    const results = await Promise.all(Array.from({ length: 6 }, () => queue.claim()));
    expect(results.filter(Boolean)).toHaveLength(1);
  });

  it("does not hand out a job before its time, or one that is leased", async () => {
    await queue.enqueue("SYNC_SOURCE", sourceId, 3600);
    expect(await queue.claim()).toBeNull();
    await prisma.knowledgeJob.updateMany({ data: { runAfter: new Date(Date.now() - 1000) } });
    expect(await queue.claim()).not.toBeNull();
    expect(await queue.claim()).toBeNull();
  });

  it("lets a lapsed lease be picked up again", async () => {
    await queue.enqueue("SYNC_SOURCE", sourceId);
    await queue.claim();
    await prisma.knowledgeJob.updateMany({ data: { leasedUntil: new Date(Date.now() - 1000) } });
    const again = await queue.claim();
    expect(again?.attempts).toBe(2);
  });

  it("runs a job once more when it was requested while running", async () => {
    await queue.enqueue("SYNC_SOURCE", sourceId);
    const job = (await queue.claim())!;
    await queue.enqueue("SYNC_SOURCE", sourceId); // arrives mid-run
    await queue.complete(job);
    expect(await jobCount()).toBe(1);
    const next = await queue.claim();
    expect(next?.attempts).toBe(1);
    await queue.complete(next!);
    expect(await jobCount()).toBe(0);
  });

  it("backs off on failure and gives up after the last attempt", async () => {
    await queue.enqueue("SYNC_SOURCE", sourceId);
    const job = (await queue.claim())!;
    expect(await queue.fail(job, "boom")).toBe(false);
    const row = await prisma.knowledgeJob.findFirstOrThrow();
    expect(row.runAfter.getTime()).toBeGreaterThan(Date.now() + 20_000);
    expect(row.lastError).toBe("boom");
    expect(await queue.fail({ ...job, attempts: queue.MAX_ATTEMPTS }, "boom")).toBe(true);
    expect(await jobCount()).toBe(0);
  });
});

describe("embeddings (fake driver)", () => {
  it("is deterministic, unit length and 768 wide", async () => {
    const [a, b] = await embedTexts(["renewal terms", "renewal terms"], "document");
    expect(a).toEqual(b);
    expect(a).toHaveLength(768);
    expect(Math.hypot(...a)).toBeCloseTo(1, 5);
  });
});

describe("syncSource", () => {
  it("records new files, flags unreadable types, and queues the rest", async () => {
    drive.files = [file("a"), file("b", { mimeType: "image/png" })];
    await syncSource(sourceId);
    const files = await prisma.knowledgeFile.findMany({ orderBy: { externalId: "asc" } });
    expect(files.map((f) => [f.externalId, f.status])).toEqual([
      ["a", "PENDING"],
      ["b", "UNSUPPORTED"],
    ]);
    expect(files[1].error).toMatch(/cannot be read/);
    expect(await prisma.knowledgeJob.findMany({ where: { kind: "INDEX_FILE" } })).toHaveLength(1);
    expect((await prisma.knowledgeSource.findUniqueOrThrow({ where: { id: sourceId } })).lastSyncedAt).not.toBeNull();
  });

  it("remembers the folder tree, and still syncs when push setup fails", async () => {
    vi.mocked(ensureWatch).mockRejectedValueOnce(new Error("channel refused"));
    vi.spyOn(console, "warn").mockImplementation(() => {});
    drive.files = [file("a")];
    await syncSource(sourceId);
    const source = await prisma.knowledgeSource.findUniqueOrThrow({ where: { id: sourceId } });
    expect(source.folderIds).toEqual(["folder1"]);
    expect(await prisma.knowledgeFile.count()).toBe(1);
  });

  it("re-queues only files whose revision changed", async () => {
    drive.files = [file("a"), file("b")];
    drive.texts = { a: "alpha", b: "beta" };
    await syncSource(sourceId);
    await runKnowledgeJobs();
    expect(await jobCount()).toBe(0);

    drive.files = [file("a", { revision: "r2" }), file("b")];
    await syncSource(sourceId);
    const jobs = await prisma.knowledgeJob.findMany();
    expect(jobs).toHaveLength(1);
    const changed = await prisma.knowledgeFile.findFirstOrThrow({ where: { externalId: "a" } });
    expect(jobs[0].targetId).toBe(changed.id);
    expect(changed.status).toBe("PENDING");
  });

  it("reads after all a file that was turned away for its type, once that type is readable (Word, Excel, PowerPoint)", async () => {
    const docx = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
    drive.files = [file("w", { mimeType: docx }), file("old", { mimeType: "application/msword" })];
    drive.texts = {};
    await syncSource(sourceId);
    // Both were recorded as unsupported before Word files could be read.
    await prisma.knowledgeFile.updateMany({
      data: { status: "UNSUPPORTED", error: "This file type cannot be read yet." },
    });
    await prisma.knowledgeJob.deleteMany({});

    await syncSource(sourceId);
    const w = await prisma.knowledgeFile.findFirstOrThrow({ where: { externalId: "w" } });
    const old = await prisma.knowledgeFile.findFirstOrThrow({ where: { externalId: "old" } });
    expect(w).toMatchObject({ status: "PENDING", error: null });
    expect(old).toMatchObject({ status: "UNSUPPORTED" }); // the binary .doc is still not readable
    const jobs = await prisma.knowledgeJob.findMany();
    expect(jobs.map((j) => j.targetId)).toEqual([w.id]);
  });

  it("keeps a file out that its owner left out, even when a new version arrives", async () => {
    drive.files = [file("a")];
    drive.texts = { a: "alpha" };
    await syncSource(sourceId);
    await runKnowledgeJobs();
    const row = await prisma.knowledgeFile.findFirstOrThrow({ where: { externalId: "a" } });
    await prisma.knowledgeFile.update({
      where: { id: row.id },
      data: { status: "UNSUPPORTED", error: "Left out because you chose to.", chunkCount: 0 },
    });
    await prisma.knowledgeChunk.deleteMany({ where: { fileId: row.id } });

    drive.files = [file("a", { revision: "r2" })];
    await syncSource(sourceId);
    const after = await prisma.knowledgeFile.findUniqueOrThrow({ where: { id: row.id } });
    expect(after).toMatchObject({ status: "UNSUPPORTED", revision: "r2" });
    expect(await jobCount()).toBe(0);
  });

  it("removes a file that left the folder, along with its chunks", async () => {
    drive.files = [file("a")];
    drive.texts = { a: "alpha text" };
    await syncSource(sourceId);
    await runKnowledgeJobs();
    expect(await prisma.knowledgeChunk.count()).toBe(1);

    drive.files = [];
    await syncSource(sourceId);
    expect(await prisma.knowledgeChunk.count()).toBe(0);
    expect((await prisma.knowledgeFile.findFirstOrThrow()).status).toBe("REMOVED");
  });

  it("does not treat files past the cap as removed", async () => {
    drive.files = [file("a")];
    await syncSource(sourceId);
    drive.files = [];
    drive.truncated = true;
    await syncSource(sourceId);
    expect((await prisma.knowledgeFile.findFirstOrThrow()).status).toBe("PENDING");
  });

  it("marks the source for reconnecting when the Google connection is dead, without retrying", async () => {
    vi.mocked(getGoogleAccessToken).mockRejectedValue(new GoogleAuthError("revoked", "invalid_grant", true));
    await queue.enqueue("SYNC_SOURCE", sourceId);
    const summary = await runKnowledgeJobs();
    expect(summary.failed).toBe(0);
    expect((await prisma.knowledgeSource.findUniqueOrThrow({ where: { id: sourceId } })).status).toBe("NEEDS_RECONNECT");
    expect(await jobCount()).toBe(0);
  });

  it("resumes and re-syncs once the user reconnects", async () => {
    await prisma.knowledgeSource.update({ where: { id: sourceId }, data: { status: "NEEDS_RECONNECT" } });
    await resumeKnowledgeSources(accountId);
    expect((await prisma.knowledgeSource.findUniqueOrThrow({ where: { id: sourceId } })).status).toBe("ACTIVE");
    expect((await prisma.knowledgeJob.findFirstOrThrow()).kind).toBe("SYNC_SOURCE");
  });

  it("pauses the source when the folder is gone", async () => {
    drive.failList = new DriveError("gone", 404);
    await syncSource(sourceId);
    const source = await prisma.knowledgeSource.findUniqueOrThrow({ where: { id: sourceId } });
    expect(source.status).toBe("PAUSED");
  });

  it("lets a transient Drive error retry rather than lose the source", async () => {
    drive.failList = new DriveError("busy", 503);
    await queue.enqueue("SYNC_SOURCE", sourceId);
    const summary = await runKnowledgeJobs();
    expect(summary.failed).toBe(1);
    expect((await prisma.knowledgeSource.findUniqueOrThrow({ where: { id: sourceId } })).status).toBe("ACTIVE");
    expect(await jobCount()).toBe(1);
  });
});

describe("indexFile", () => {
  async function seedFile(text: string, over: Record<string, unknown> = {}) {
    drive.files = [file("a", over)];
    drive.texts = { a: text };
    await syncSource(sourceId);
    return prisma.knowledgeFile.findFirstOrThrow();
  }

  it("stores chunks with embeddings and marks the file ready", async () => {
    const f = await seedFile("The renewal term is twelve months.\n\nNotice must be given in writing.");
    await indexFile(f.id);
    const after = await prisma.knowledgeFile.findUniqueOrThrow({ where: { id: f.id } });
    expect(after).toMatchObject({ status: "READY", chunkCount: 1, indexedRevision: "r1" });
    const rows = await prisma.$queryRaw<{ dims: number }[]>`
      SELECT vector_dims(embedding) AS dims FROM "KnowledgeChunk"`;
    expect(rows[0].dims).toBe(768);
  });

  it("finds the relevant chunk by vector similarity", async () => {
    drive.files = [file("a"), file("b")];
    drive.texts = {
      a: "Payment terms are net thirty days from invoice date.",
      b: "The office dog is named Biscuit and likes long walks.",
    };
    await syncSource(sourceId);
    await runKnowledgeJobs();
    const [q] = await embedTexts(["a.txt\n\nwhat are the payment terms net thirty days"], "query");
    const hits = await prisma.$queryRaw<{ content: string }[]>`
      SELECT content FROM "KnowledgeChunk"
      WHERE "sourceId" = ${sourceId}
      ORDER BY embedding <=> ${toVectorLiteral(q)}::vector LIMIT 1`;
    expect(hits[0].content).toMatch(/Payment terms/);
  });

  it("replaces the old chunks when a file changes", async () => {
    const f = await seedFile("first version");
    await indexFile(f.id);
    drive.texts = { a: "second version" };
    await prisma.knowledgeFile.update({ where: { id: f.id }, data: { revision: "r2" } });
    await indexFile(f.id);
    const chunks = await prisma.knowledgeChunk.findMany();
    expect(chunks.map((c) => c.content)).toEqual(["second version"]);
  });

  it("asks for another pass if the file changed while it was being read", async () => {
    const f = await seedFile("first");
    const { readFileText } = await import("@/lib/drive");
    vi.mocked(readFileText).mockImplementationOnce(async () => {
      await prisma.knowledgeFile.update({ where: { id: f.id }, data: { revision: "r2" } });
      return { ok: true, text: "first" };
    });
    expect(await indexFile(f.id)).toEqual({ again: true });
  });

  it("reports an unreadable file as unsupported, with the reason", async () => {
    const f = await seedFile("x");
    delete drive.texts.a;
    await indexFile(f.id);
    expect(await prisma.knowledgeFile.findUniqueOrThrow({ where: { id: f.id } })).toMatchObject({
      status: "UNSUPPORTED",
      error: "The file is empty.",
    });
  });

  it("treats a file deleted in Drive as removed", async () => {
    const f = await seedFile("x");
    drive.failRead[f.externalId] = new DriveError("gone", 404);
    await indexFile(f.id);
    expect((await prisma.knowledgeFile.findUniqueOrThrow({ where: { id: f.id } })).status).toBe("REMOVED");
  });

  it("retries a temporary failure, then marks the file failed with the reason once retries run out", async () => {
    const f = await seedFile("x");
    drive.failRead[f.externalId] = new DriveError("busy", 503);
    await queue.enqueue("INDEX_FILE", f.id);
    await runKnowledgeJobs();
    expect((await prisma.knowledgeFile.findUniqueOrThrow({ where: { id: f.id } })).status).toBe("PENDING");

    for (let i = 0; i < queue.MAX_ATTEMPTS; i++) {
      await prisma.knowledgeJob.updateMany({ data: { runAfter: new Date(Date.now() - 1000) } });
      await runKnowledgeJobs();
    }
    const after = await prisma.knowledgeFile.findUniqueOrThrow({ where: { id: f.id } });
    expect(after.status).toBe("FAILED");
    expect(after.error).toMatch(/busy/);
  });
});

describe("worker and sources", () => {
  it("queues a sync for a source that has never synced or is overdue, not a fresh one", async () => {
    expect(await enqueueDueSyncs()).toBe(1);
    await prisma.knowledgeSource.update({ where: { id: sourceId }, data: { lastSyncedAt: new Date() } });
    await prisma.knowledgeJob.deleteMany({});
    expect(await enqueueDueSyncs()).toBe(0);
  });

  it("drains a whole folder through the queue", async () => {
    drive.files = [file("a"), file("b"), file("c")];
    drive.texts = { a: "one", b: "two", c: "three" };
    await queue.enqueue("SYNC_SOURCE", sourceId);
    await runKnowledgeJobs();
    expect(await prisma.knowledgeFile.count({ where: { status: "READY" } })).toBe(3);
    expect(await jobCount()).toBe(0);
  });

  it("creates a source for the user's own connected folder and refuses someone else's account", async () => {
    await prisma.knowledgeSource.deleteMany({});
    const ok = await createKnowledgeSource(userId, { installationId, accountId, folderId: "f9" });
    expect(ok).toMatchObject({ ok: true, folderName: "Contracts" });
    expect((await prisma.knowledgeJob.findFirstOrThrow()).kind).toBe("SYNC_SOURCE");

    const other = await createKnowledgeSource("nobody", { installationId, accountId, folderId: "f9" });
    expect(other.ok).toBe(false);
  });
});
