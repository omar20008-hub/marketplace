import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * A big file hit by a per-minute rate limit part-way must not start over: what was
 * embedded stays, the next pass carries on, and the pause is not a failed attempt.
 */

vi.mock("@/lib/auth", () => ({ requireUser: async () => null }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

const drive = vi.hoisted(() => ({ text: "" }));
vi.mock("@/lib/drive", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/drive")>();
  return { ...actual, readFileText: vi.fn(async () => ({ ok: true, text: drive.text })) };
});
vi.mock("@/server/google-account", () => ({
  getGoogleAccessToken: vi.fn(async () => "token"),
  saveGoogleConnection: vi.fn(),
}));

/** Which call of embedTexts should be refused with a rate limit (1-based); 0 = none. */
const limit = vi.hoisted(() => ({ failOnCall: 0, calls: 0, embedded: [] as string[], quota: "minute" as "minute" | "day" }));
vi.mock("@/lib/embeddings", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/embeddings")>();
  return {
    ...actual,
    embedTexts: vi.fn(async (texts: string[], task: "document" | "query") => {
      limit.calls++;
      if (limit.failOnCall && limit.calls === limit.failOnCall) {
        throw new actual.EmbeddingError("Embedding API answered 429.", true, { retryAfterSeconds: 45, quota: limit.quota });
      }
      limit.embedded.push(...texts);
      return actual.embedTexts(texts, task);
    }),
  };
});

const { prisma } = await import("@/lib/db");
const { indexFile } = await import("@/server/knowledge/indexer");
const { chunkText } = await import("@/lib/chunking");
const { seedInstallation } = await import("./knowledge-fixtures");

const paragraph = (i: number) => `Section ${i}. ` + `word${i} `.repeat(150);
const bigText = Array.from({ length: 60 }, (_, i) => paragraph(i)).join("\n\n");

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

async function seedFile() {
  await prisma.plan.create({
    data: { id: "res", name: "R", monthlyRuns: 1, storageBytes: BigInt(1), monthlyCredits: 0 },
  });
  const user = await prisma.user.create({
    data: { email: "r@example.test", name: "R", passwordHash: "x", initials: "R", planId: "res" },
  });
  const installation = await seedInstallation(user.id);
  const account = await prisma.connectedAccount.create({
    data: { userId: user.id, credentialType: "googleDriveOAuth2Api", displayName: "Google Drive", initials: "GD", accountRef: "r@example.test", status: "ACTIVE" },
  });
  const source = await prisma.knowledgeSource.create({
    data: { userId: user.id, installationId: installation.id, accountId: account.id, folderId: "f", folderName: "F" },
  });
  return prisma.knowledgeFile.create({
    data: { sourceId: source.id, externalId: "big", name: "big.pdf", mimeType: "application/pdf", revision: "r1", status: "PENDING" },
  });
}

beforeEach(async () => {
  await wipe();
  drive.text = bigText;
  limit.failOnCall = 0;
  limit.calls = 0;
  limit.embedded = [];
  limit.quota = "minute";
});
afterAll(async () => {
  await wipe();
  await prisma.$disconnect();
});

describe("indexing a file that is rate-limited part-way", () => {
  it("keeps what it embedded, defers without failing, and resumes after it", async () => {
    const total = chunkText(bigText).length;
    expect(total).toBeGreaterThan(50);
    const file = await seedFile();

    limit.failOnCall = 3; // two steps (50 chunks) succeed, the third is refused
    const first = await indexFile(file.id);
    expect(first).toEqual({ deferSeconds: 45 });
    let row = await prisma.knowledgeFile.findUniqueOrThrow({ where: { id: file.id } });
    expect(row.status).toBe("PENDING");
    expect(row.chunkCount).toBe(0);
    expect(await prisma.knowledgeChunk.count({ where: { fileId: file.id } })).toBe(50);

    limit.embedded = [];
    limit.failOnCall = 0;
    const second = await indexFile(file.id);
    expect(second).toEqual({ again: false });
    // Only the remainder was embedded this time.
    expect(limit.embedded).toHaveLength(total - 50);

    row = await prisma.knowledgeFile.findUniqueOrThrow({ where: { id: file.id } });
    expect(row).toMatchObject({ status: "READY", chunkCount: total, partialRevision: null, indexedRevision: "r1" });
    const ordinals = (await prisma.knowledgeChunk.findMany({ where: { fileId: file.id }, select: { ordinal: true }, orderBy: { ordinal: "asc" } })).map((c) => c.ordinal);
    expect(ordinals).toEqual(Array.from({ length: total }, (_, i) => i));
  });

  it("starts over when the file changed in the meantime", async () => {
    const file = await seedFile();
    limit.failOnCall = 2;
    await indexFile(file.id);
    expect(await prisma.knowledgeChunk.count({ where: { fileId: file.id } })).toBe(25);

    await prisma.knowledgeFile.update({ where: { id: file.id }, data: { revision: "r2", status: "PENDING" } });
    limit.failOnCall = 0;
    limit.embedded = [];
    await indexFile(file.id);
    const total = chunkText(bigText).length;
    expect(limit.embedded).toHaveLength(total); // nothing reused from the old revision
    expect(await prisma.knowledgeChunk.count({ where: { fileId: file.id } })).toBe(total);
  });

  it("still throws, so an attempt is spent, when nothing at all could be embedded", async () => {
    const file = await seedFile();
    limit.failOnCall = 1;
    await expect(indexFile(file.id)).rejects.toThrow(/429/);
    expect((await prisma.knowledgeFile.findUniqueOrThrow({ where: { id: file.id } })).status).toBe("PENDING");
  });

  it("waits for the next quota day, keeping what it has, when the provider's daily quota is spent", async () => {
    const file = await seedFile();
    limit.quota = "day";
    limit.failOnCall = 1; // refused at once: no progress, and a daily limit
    const outcome = await indexFile(file.id);
    expect(outcome.deferSeconds).toBeGreaterThan(60); // until midnight Pacific, not a minute
    const row = await prisma.knowledgeFile.findUniqueOrThrow({ where: { id: file.id } });
    expect(row.status).toBe("PENDING");
    expect(row.error).toMatch(/allowance is used up/);

    // Part-way: stored chunks stay, and the wait is the same.
    limit.calls = 0;
    limit.failOnCall = 2;
    const again = await indexFile(file.id);
    expect(again.deferSeconds).toBeGreaterThan(60);
    expect(await prisma.knowledgeChunk.count({ where: { fileId: file.id } })).toBe(25);
  });

  it("indexes text with NUL bytes and lone surrogates in it, which Postgres cannot store as they are", async () => {
    // A PDF's extracted text can carry both; stored as they are, the insert fails
    // ("invalid byte sequence … 0x00") on the batch that holds them, every pass.
    drive.text = bigText.replace("Section 7.", "Section\u0000 7.\ud800").replace("Section 30.", "Section 30.\u0001\u0007");
    const file = await seedFile();
    await indexFile(file.id);
    const row = await prisma.knowledgeFile.findUniqueOrThrow({ where: { id: file.id } });
    expect(row.status).toBe("READY");
    const stored = await prisma.knowledgeChunk.findMany({ where: { fileId: file.id }, select: { content: true } });
    expect(stored.some((c) => c.content.includes("\u0000"))).toBe(false);
    expect(stored.some((c) => /Section\s+7/.test(c.content))).toBe(true); // the text around it is kept
  });

  it("marks a file whose text is unreadable as skipped, without embedding anything", async () => {
    drive.text = Array.from({ length: 120 }, () => "\u0000\u0000a\u0000\u0000b\u0000 ").join("");
    const file = await seedFile();
    await indexFile(file.id);
    const row = await prisma.knowledgeFile.findUniqueOrThrow({ where: { id: file.id } });
    expect(row).toMatchObject({ status: "UNSUPPORTED", chunkCount: 0 });
    expect(row.error).toMatch(/unreadable/);
    expect(limit.calls).toBe(0);
  });

  it("does not show a half-indexed file to search", async () => {
    const file = await seedFile();
    limit.failOnCall = 2;
    await indexFile(file.id);
    const { searchKnowledge } = await import("@/server/knowledge/search");
    const source = await prisma.knowledgeSource.findFirstOrThrow({ where: { id: file.sourceId } });
    const result = await searchKnowledge(source.installationId, "word3");
    expect(result.passages).toEqual([]);
  });
});
