import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * A failed job says what failed, why (as a kind), and when it will be retried — in
 * the log, on separate lines — without ever saying what the error itself said,
 * which can quote a value or a file's content.
 */

const failures = vi.hoisted(() => ({ read: null as unknown, embed: null as unknown, list: null as unknown }));

vi.mock("@/lib/drive", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/drive")>();
  return {
    ...actual,
    listTree: vi.fn(async () => {
      if (failures.list) throw failures.list;
      return { files: [], folders: ["f1"], truncated: false };
    }),
    readFileText: vi.fn(async () => {
      if (failures.read) throw failures.read;
      return { ok: true, text: "some text" };
    }),
  };
});
vi.mock("@/lib/embeddings", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/embeddings")>();
  return {
    ...actual,
    embedTexts: vi.fn(async (...args: Parameters<typeof actual.embedTexts>) => {
      if (failures.embed) throw failures.embed;
      return actual.embedTexts(...args);
    }),
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
const { DriveError } = await import("@/lib/drive");
const { EmbeddingError } = await import("@/lib/embeddings");
const { GoogleAuthError, GOOGLE_DRIVE_CREDENTIAL } = await import("@/lib/google-oauth");
const { classifyJobError, logName } = await import("@/server/knowledge/errors");
const { enqueue, MAX_ATTEMPTS, retryDelaySeconds } = await import("@/server/knowledge/queue");
const { runKnowledgeJobs } = await import("@/server/knowledge/worker");
const { runScheduledPass } = await import("@/server/knowledge/scheduler");
const { tickKnowledge } = await import("@/server/knowledge/worker");
const { seedInstallation } = await import("./knowledge-fixtures");

const SECRET = "sk-super-secret-value-123";

describe("classifyJobError", () => {
  const cases: [string, unknown, string][] = [
    ["embeddings 429", new EmbeddingError("Embedding API answered 429.", true), "embeddings_rate_limit"],
    ["embeddings 503", new EmbeddingError("Embedding API answered 503.", true), "embeddings_server_error"],
    ["embeddings 400", new EmbeddingError("Embedding API answered 400.", false), "embeddings_http_400"],
    ["embeddings network", new EmbeddingError("Embedding request failed: socket hang up", true), "embeddings_network"],
    ["embeddings key", new EmbeddingError("GEMINI_API_KEY is not set.", false), "embeddings_not_configured"],
    ["embeddings other", new EmbeddingError("Embedding API returned the wrong number of vectors.", true), "embeddings_error"],
    ["drive 429", new DriveError("Drive answered 429.", 429), "drive_rate_limit"],
    ["drive 403", new DriveError("Drive answered 403.", 403), "drive_forbidden"],
    ["drive 401", new DriveError("Drive answered 401.", 401), "drive_unauthorized"],
    ["drive 500", new DriveError("Drive answered 500.", 500), "drive_server_error"],
    ["drive network", new DriveError("Drive request failed: boom", 0), "drive_network"],
    ["drive 400", new DriveError("Drive answered 400.", 400), "drive_http_400"],
    ["google auth", new GoogleAuthError("x", "invalid_grant", true), "google_auth"],
    ["nul byte", new Error('invalid byte sequence for encoding "UTF8": 0x00'), "nul_byte_in_text"],
    ["pdf", Object.assign(new Error("Invalid PDF structure."), { name: "InvalidPDFException" }), "pdf_parse_error"],
    ["password", new Error("No password given"), "pdf_parse_error"],
    ["timeout", new Error("Transaction API error: timed out"), "timeout"],
    ["connection", new Error("read ECONNRESET"), "network"],
    ["prisma", Object.assign(new Error("whatever"), { name: "PrismaClientKnownRequestError", code: "P2028" }), "database_error_P2028"],
    ["unknown class", Object.assign(new Error("odd"), { name: "WeirdError!" }), "error_WeirdError"],
    ["not an error", "a string", "unknown"],
  ];
  for (const [label, error, expected] of cases) {
    it(label, () => expect(classifyJobError(error)).toBe(expected));
  }

  it("never lets the error's own text into the result", () => {
    const errors = [
      new Error(`failed with token ${SECRET}`),
      new EmbeddingError(`Embedding API answered 429. key=${SECRET}`, true),
      new DriveError(`Drive answered 500. ${SECRET}`, 500),
    ];
    for (const error of errors) expect(classifyJobError(error)).not.toContain(SECRET);
  });
});

describe("logName", () => {
  it("is one bounded line", () => {
    expect(logName("a\nb\r\n\tc\u0000d")).toBe("a b c d");
    expect(logName("x".repeat(500))).toHaveLength(120);
    expect(logName("دليل منهجية.pdf")).toBe("دليل منهجية.pdf");
  });
});

describe("the retry delay", () => {
  it("backs off 30s, 2m, 8m, 32m", () => {
    expect([1, 2, 3, 4].map((n) => retryDelaySeconds(n))).toEqual([30, 120, 480, 1920]);
  });
});

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
  await prisma.heartbeat.deleteMany({});
}

async function seedFile(name: string) {
  await prisma.plan.create({
    data: { id: "fl", name: "T", monthlyRuns: 1, storageBytes: BigInt(1), monthlyCredits: 0, knowledgeFiles: 100 },
  });
  const user = await prisma.user.create({
    data: { email: "f@example.test", name: "F", passwordHash: "x", initials: "F", planId: "fl" },
  });
  const installation = await seedInstallation(user.id);
  const account = await prisma.connectedAccount.create({
    data: { userId: user.id, credentialType: GOOGLE_DRIVE_CREDENTIAL, displayName: "G", initials: "G", accountRef: "f@example.test", status: "ACTIVE" },
  });
  const source = await prisma.knowledgeSource.create({
    data: { userId: user.id, installationId: installation.id, accountId: account.id, folderId: "f1", folderName: "Folder\nOne", lastSyncedAt: new Date() },
  });
  return prisma.knowledgeFile.create({
    data: { sourceId: source.id, externalId: "e1", name, mimeType: "text/plain", revision: "r" },
  });
}

beforeEach(async () => {
  await wipe();
  failures.read = null;
  failures.embed = null;
  failures.list = null;
});
afterAll(async () => {
  await wipe();
  await prisma.$disconnect();
});

describe("runKnowledgeJobs on a failing file", () => {
  it("logs the kind, the attempt and the retry time, with the file on its own line", async () => {
    const file = await seedFile("دليل منهجية.pdf");
    failures.embed = new EmbeddingError(`Embedding API answered 429. ${SECRET}`, true);
    await enqueue("INDEX_FILE", file.id);

    const lines: string[] = [];
    const summary = await runKnowledgeJobs({ log: (line) => lines.push(line) });

    expect(summary).toMatchObject({ ran: 0, failed: 1, gaveUp: 0, failedByType: { embeddings_rate_limit: 1 } });
    expect(lines).toEqual([
      "knowledge job failed: kind=INDEX_FILE type=embeddings_rate_limit attempt=1/12 retry_in=60s",
      "knowledge job file: دليل منهجية.pdf",
    ]);
    expect(lines.join("\n")).not.toContain(SECRET);
  });

  it("says when it gives up", async () => {
    const file = await seedFile("big.pdf");
    failures.read = Object.assign(new Error("Invalid PDF structure."), { name: "InvalidPDFException" });
    await enqueue("INDEX_FILE", file.id);
    await prisma.knowledgeJob.updateMany({ data: { attempts: MAX_ATTEMPTS - 1 } });

    const lines: string[] = [];
    const summary = await runKnowledgeJobs({ log: (line) => lines.push(line) });
    expect(summary.gaveUp).toBe(1);
    expect(lines[0]).toBe(`knowledge job failed: kind=INDEX_FILE type=pdf_parse_error attempt=${MAX_ATTEMPTS}/${MAX_ATTEMPTS} gave up`);
    expect(lines[1]).toBe("knowledge job file: big.pdf");
  });

  it("names the folder for a failed sync", async () => {
    await seedFile("x.txt");
    failures.list = new DriveError("Drive answered 503.", 503);
    const source = await prisma.knowledgeSource.findFirstOrThrow();
    await enqueue("SYNC_SOURCE", source.id);
    const lines: string[] = [];
    await runKnowledgeJobs({ log: (line) => lines.push(line) });
    expect(lines[0]).toMatch(/^knowledge job failed: kind=SYNC_SOURCE type=drive_server_error attempt=1\/5 retry_in=30s$/);
    expect(lines[1]).toBe("knowledge job folder: Folder One");
  });

  it("keeps working if the log line itself cannot be written", async () => {
    const file = await seedFile("a.txt");
    failures.embed = new EmbeddingError("Embedding API answered 503.", true);
    await enqueue("INDEX_FILE", file.id);
    const summary = await runKnowledgeJobs({
      log: () => {
        throw new Error("log is broken");
      },
    });
    expect(summary.failed).toBe(1);
  });
});

describe("the tick line", () => {
  it("is unchanged when nothing failed, and carries the kinds when something did", async () => {
    const quiet: string[] = [];
    await runScheduledPass(tickKnowledge, (line) => quiet.push(line));
    expect(quiet).toEqual(["knowledge tick ok: queued=0 ran=0 failed=0 gaveUp=0"]);

    const file = await seedFile("b.pdf");
    failures.embed = new EmbeddingError("Embedding API answered 429.", true);
    await enqueue("INDEX_FILE", file.id);
    await prisma.knowledgeJob.updateMany({ data: { runAfter: new Date(Date.now() - 1000) } });
    const noisy: string[] = [];
    await runScheduledPass(tickKnowledge, (line) => noisy.push(line));
    expect(noisy[0]).toBe("knowledge tick ok: queued=0 ran=0 failed=1 gaveUp=0 types=embeddings_rate_limit:1");
  });
});
