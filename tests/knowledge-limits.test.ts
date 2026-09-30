import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * What a plan allows, what happens when the embedding model changes, and what
 * disconnecting or uninstalling leaves behind.
 */

const viewer = vi.hoisted(() => ({ current: null as { id: string } | null }));
vi.mock("@/lib/auth", () => ({ requireUser: async () => viewer.current }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("next/navigation", () => ({ redirect: vi.fn() }));

const drive = vi.hoisted(() => ({ files: [] as Array<Record<string, unknown>> }));
vi.mock("@/lib/drive", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/drive")>();
  return {
    ...actual,
    listTree: vi.fn(async () => ({ files: drive.files, folders: ["folder1"], truncated: false })),
    readFileText: vi.fn(async () => ({ ok: true, text: "some text to index" })),
    getFolder: vi.fn(async (_t: string, id: string) => ({ id, name: `Folder ${id}` })),
  };
});
vi.mock("@/server/google-account", () => ({
  getGoogleAccessToken: vi.fn(async () => "token"),
  saveGoogleConnection: vi.fn(),
}));
const stopWatch = vi.hoisted(() => vi.fn(async () => {}));
vi.mock("@/server/knowledge/watch", () => ({
  ensureWatch: vi.fn(async () => {}),
  renewWatches: vi.fn(async () => ({ renewed: 0, failed: 0 })),
  stopWatch,
}));

const { prisma } = await import("@/lib/db");
const { GOOGLE_DRIVE_CREDENTIAL } = await import("@/lib/google-oauth");
const { syncSource } = await import("@/server/knowledge/indexer");
const { runKnowledgeJobs } = await import("@/server/knowledge/worker");
const { createKnowledgeSource } = await import("@/server/knowledge/sources");
const { reindexFiles } = await import("@/server/knowledge/reindex");
const { searchKnowledge } = await import("@/server/knowledge/search");
const { embeddingTag } = await import("@/lib/embeddings");
const { disconnectAccount } = await import("@/server/account-actions");
const { seedInstallation } = await import("./knowledge-fixtures");

const file = (id: string, over: Record<string, unknown> = {}) => ({
  id, name: `${id}.txt`, mimeType: "text/plain", revision: "r1", webUrl: null, path: "", size: 5, ...over,
});

let userId = "";
let accountId = "";
let installationId = "";

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

async function setup(limits: { knowledgeSources?: number; knowledgeFiles?: number } = {}) {
  await prisma.plan.create({
    data: { id: "lim", name: "Tiny", monthlyRuns: 1, storageBytes: BigInt(1), monthlyCredits: 0, knowledgeSources: 1, knowledgeFiles: 3, ...limits },
  });
  const user = await prisma.user.create({
    data: { email: "l@example.test", name: "L", passwordHash: "x", initials: "L", planId: "lim" },
  });
  userId = user.id;
  viewer.current = user;
  accountId = (
    await prisma.connectedAccount.create({
      data: { userId, credentialType: GOOGLE_DRIVE_CREDENTIAL, displayName: "Google Drive", initials: "GD", accountRef: "l@example.test", status: "ACTIVE" },
    })
  ).id;
  installationId = (await seedInstallation(userId)).id;
}

beforeEach(async () => {
  await wipe();
  drive.files = [];
  stopWatch.mockClear();
});
afterAll(async () => {
  await wipe();
  await prisma.$disconnect();
});

const attach = (folderId: string, instId = installationId) =>
  createKnowledgeSource(userId, { installationId: instId, accountId, folderId });

describe("folder limit", () => {
  it("allows up to the plan's folders, and says what to do at the limit", async () => {
    await setup({ knowledgeSources: 1 });
    expect((await attach("folder-a-0001")).ok).toBe(true);
    const second = await attach("folder-b-0001");
    expect(second).toMatchObject({ ok: false, error: expect.stringMatching(/Tiny plan includes 1 folder\./) });
  });

  it("does not count re-attaching the same folder as a new one", async () => {
    await setup({ knowledgeSources: 1 });
    await attach("folder-a-0001");
    expect((await attach("folder-a-0001")).ok).toBe(true);
    expect(await prisma.knowledgeSource.count()).toBe(1);
  });

  it("counts folders across all of a user's installations", async () => {
    await setup({ knowledgeSources: 1 });
    await attach("folder-a-0001");
    const other = await seedInstallation(userId, { key: "second" });
    expect((await attach("folder-b-0001", other.id)).ok).toBe(false);
  });
});

describe("file limit", () => {
  async function source() {
    return prisma.knowledgeSource.create({
      data: { userId, installationId, accountId, folderId: "folder1", folderName: "F" },
    });
  }

  it("adds files up to the allowance, turns the rest away, and says so", async () => {
    await setup({ knowledgeFiles: 3 });
    const s = await source();
    drive.files = ["a", "b", "c", "d", "e"].map((id) => file(id));
    await syncSource(s.id);
    expect(await prisma.knowledgeFile.count()).toBe(3);
    const after = await prisma.knowledgeSource.findUniqueOrThrow({ where: { id: s.id } });
    expect(after.lastError).toMatch(/allows 3 files, so 2 new files were not added/);
  });

  it("does not spend the allowance on files it cannot read", async () => {
    await setup({ knowledgeFiles: 2 });
    const s = await source();
    drive.files = [file("img1", { mimeType: "image/png" }), file("img2", { mimeType: "image/png" }), file("a"), file("b")];
    await syncSource(s.id);
    expect(await prisma.knowledgeFile.count({ where: { status: "PENDING" } })).toBe(2);
    expect((await prisma.knowledgeSource.findUniqueOrThrow({ where: { id: s.id } })).lastError).toBeNull();
  });

  it("still updates a file it already has when the allowance is used up", async () => {
    await setup({ knowledgeFiles: 1 });
    const s = await source();
    drive.files = [file("a")];
    await syncSource(s.id);
    drive.files = [file("a", { revision: "r2" })];
    await syncSource(s.id);
    expect((await prisma.knowledgeFile.findFirstOrThrow()).revision).toBe("r2");
    expect((await prisma.knowledgeSource.findUniqueOrThrow({ where: { id: s.id } })).lastError).toBeNull();
  });

  it("frees the allowance when a file leaves the folder", async () => {
    await setup({ knowledgeFiles: 1 });
    const s = await source();
    drive.files = [file("a")];
    await syncSource(s.id);
    drive.files = [file("b")];
    await syncSource(s.id);
    const b = await prisma.knowledgeFile.findFirst({ where: { externalId: "b" } });
    expect(b?.status).toBe("PENDING");
  });
});

describe("changing the embedding model", () => {
  async function indexed() {
    await setup();
    const s = await prisma.knowledgeSource.create({
      data: { userId, installationId, accountId, folderId: "folder1", folderName: "F" },
    });
    drive.files = [file("a")];
    await syncSource(s.id);
    await runKnowledgeJobs();
    return s;
  }

  it("records which model embedded a file", async () => {
    await indexed();
    expect((await prisma.knowledgeFile.findFirstOrThrow()).embeddingModel).toBe(embeddingTag());
  });

  it("hides files from another model in search, and counts them as still being processed", async () => {
    await indexed();
    expect((await searchKnowledge(installationId, "text")).passages).toHaveLength(1);
    await prisma.knowledgeFile.updateMany({ data: { embeddingModel: "gemini:some-older-model" } });
    const result = await searchKnowledge(installationId, "text");
    expect(result.passages).toHaveLength(0);
    expect(result.library.files).toMatchObject({ ready: 0, pending: 1 });
  });

  it("re-indexes only the stale files by default, and everything with all", async () => {
    await indexed();
    expect((await reindexFiles()).queued).toBe(0);
    await prisma.knowledgeFile.updateMany({ data: { embeddingModel: "gemini:some-older-model" } });
    expect((await reindexFiles()).queued).toBe(1);
    await runKnowledgeJobs();
    expect((await prisma.knowledgeFile.findFirstOrThrow()).embeddingModel).toBe(embeddingTag());
    expect((await searchKnowledge(installationId, "text")).passages).toHaveLength(1);
    expect((await reindexFiles({ stale: false })).queued).toBe(1);
  });

  it("treats a file indexed before the model was recorded as current", async () => {
    await indexed();
    await prisma.knowledgeFile.updateMany({ data: { embeddingModel: null } });
    expect((await searchKnowledge(installationId, "text")).passages).toHaveLength(1);
    expect((await reindexFiles()).queued).toBe(0);
  });
});

describe("disconnecting Google", () => {
  it("stops watching its folders and marks them as waiting for a reconnect, keeping what was indexed", async () => {
    await setup();
    const s = await prisma.knowledgeSource.create({
      data: { userId, installationId, accountId, folderId: "folder1", folderName: "F" },
    });
    drive.files = [file("a")];
    await syncSource(s.id);
    await runKnowledgeJobs();

    const form = new FormData();
    form.set("accountId", accountId);
    await disconnectAccount(form);

    expect(stopWatch).toHaveBeenCalledWith(s.id);
    const after = await prisma.knowledgeSource.findUniqueOrThrow({ where: { id: s.id } });
    expect(after).toMatchObject({ status: "NEEDS_RECONNECT", lastError: "Google Drive was disconnected." });
    expect(await prisma.knowledgeChunk.count()).toBe(1);
  });
});
