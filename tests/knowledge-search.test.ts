import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Knowledge search as an installed workflow sees it: an HTTP call carrying that
 * installation's key. The properties that matter are the ones that keep one
 * user's files away from another's, so most of these are about what must NOT
 * come back.
 */

const viewer = vi.hoisted(() => ({ current: null as { id: string } | null }));
vi.mock("@/lib/auth", () => ({
  requireUser: async () => viewer.current,
}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("next/navigation", () => ({ redirect: vi.fn() }));
vi.mock("@/server/google-account", () => ({
  getGoogleAccessToken: vi.fn(async () => "token"),
  saveGoogleConnection: vi.fn(),
}));

const { prisma } = await import("@/lib/db");
const { embedTexts, toVectorLiteral } = await import("@/lib/embeddings");
const { newKnowledgeKey, hashKnowledgeKey, installationForKey } = await import(
  "@/server/knowledge/keys"
);
const { POST } = await import("@/app/api/knowledge/search/route");
const { uninstall } = await import("@/server/install-actions");
const { seedInstallation } = await import("./knowledge-fixtures");

const PLAN_ID = "test-plan-search";

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

async function seedUser(email: string) {
  return prisma.user.create({
    data: { email, name: email, passwordHash: "x", initials: "U", planId: PLAN_ID },
  });
}

/** An installation with a key, one source, and files already indexed. */
async function seedLibrary(
  email: string,
  files: { name: string; text: string; status?: "READY" | "PENDING" | "FAILED" }[],
) {
  const user = await seedUser(email);
  const { key, hash } = newKnowledgeKey();
  const installation = await seedInstallation(user.id, { knowledgeKeyHash: hash });
  const account = await prisma.connectedAccount.create({
    data: {
      userId: user.id,
      credentialType: "googleDriveOAuth2Api",
      displayName: "Google Drive",
      initials: "GD",
      accountRef: email,
      status: "ACTIVE",
    },
  });
  const source = await prisma.knowledgeSource.create({
    data: {
      userId: user.id,
      installationId: installation.id,
      accountId: account.id,
      folderId: `folder-${email}`,
      folderName: "Docs",
      lastSyncedAt: new Date(),
    },
  });
  for (const f of files) {
    const file = await prisma.knowledgeFile.create({
      data: {
        sourceId: source.id,
        externalId: `${email}-${f.name}`,
        name: f.name,
        mimeType: "text/plain",
        revision: "r1",
        path: "Legal",
        webUrl: `https://drive.example/${f.name}`,
        status: f.status ?? "READY",
      },
    });
    if ((f.status ?? "READY") !== "READY" && f.status !== "FAILED") continue;
    const [vec] = await embedTexts([`${f.name}\n\n${f.text}`], "document");
    await prisma.$executeRaw`
      INSERT INTO "KnowledgeChunk" (id, "fileId", "sourceId", ordinal, content, embedding)
      VALUES (gen_random_uuid()::text, ${file.id}, ${source.id}, 0, ${f.text}, ${toVectorLiteral(vec)}::vector)`;
  }
  return { user, installation, source, key };
}

function call(key: string | null, body: unknown, raw = false) {
  return POST(
    new Request("https://app.example.test/api/knowledge/search", {
      method: "POST",
      headers: { "content-type": "application/json", ...(key ? { authorization: `Bearer ${key}` } : {}) },
      body: raw ? (body as string) : JSON.stringify(body),
    }),
  );
}

beforeEach(async () => {
  await wipe();
  await prisma.plan.create({
    data: { id: PLAN_ID, name: "T", monthlyRuns: 1, storageBytes: BigInt(1), monthlyCredits: 0 },
  });
});
afterAll(async () => {
  await wipe();
  await prisma.$disconnect();
});

describe("keys", () => {
  it("issues unguessable prefixed keys and stores only a hash", () => {
    const a = newKnowledgeKey();
    const b = newKnowledgeKey();
    expect(a.key).toMatch(/^kb_[A-Za-z0-9_-]{40,}$/);
    expect(a.key).not.toBe(b.key);
    expect(a.hash).toBe(hashKnowledgeKey(a.key));
    expect(a.hash).not.toContain(a.key);
  });

  it("resolves a key only to an active installation", async () => {
    const { key, installation } = await seedLibrary("a@example.test", []);
    expect((await installationForKey(`Bearer ${key}`))?.id).toBe(installation.id);
    expect(await installationForKey(`Bearer ${key}x`)).toBeNull();
    expect(await installationForKey(key)).toBeNull();
    expect(await installationForKey(null)).toBeNull();
    await prisma.installation.update({ where: { id: installation.id }, data: { status: "DISABLED" } });
    expect(await installationForKey(`Bearer ${key}`)).toBeNull();
  });
});

describe("POST /api/knowledge/search", () => {
  it("refuses a missing or unknown key", async () => {
    await seedLibrary("a@example.test", []);
    expect((await call(null, { query: "x" })).status).toBe(401);
    expect((await call("kb_" + "z".repeat(43), { query: "x" })).status).toBe(401);
  });

  it("validates the body", async () => {
    const { key } = await seedLibrary("a@example.test", []);
    expect((await call(key, "not json", true)).status).toBe(400);
    expect((await call(key, {})).status).toBe(400);
    expect((await call(key, { query: "  " })).status).toBe(400);
    expect((await call(key, { query: "x".repeat(2001) })).status).toBe(400);
  });

  it("returns the best passage with its citation, numbered in a ready-made context", async () => {
    const { key } = await seedLibrary("a@example.test", [
      { name: "terms.txt", text: "Payment terms are net thirty days from the invoice date." },
      { name: "dog.txt", text: "The office dog is named Biscuit and loves long walks." },
    ]);
    const res = await call(key, { query: "what are the payment terms net thirty days" });
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.passages[0]).toMatchObject({
      text: expect.stringContaining("net thirty days"),
      file: { name: "terms.txt", path: "Legal", url: "https://drive.example/terms.txt" },
    });
    expect(body.context).toMatch(/^\[1\] Legal\/terms\.txt\n/);
    expect(body.library.files.ready).toBe(2);
  });

  it("never returns another installation's passages, even with identical content", async () => {
    const text = "The secret launch date is the first of March.";
    const mine = await seedLibrary("me@example.test", [{ name: "mine.txt", text }]);
    await seedLibrary("them@example.test", [{ name: "theirs.txt", text }]);
    const body = await (await call(mine.key, { query: "secret launch date" })).json();
    expect(body.passages.map((p: { file: { name: string } }) => p.file.name)).toEqual(["mine.txt"]);
  });

  it("searches only sources attached to the calling installation, not the user's other ones", async () => {
    const one = await seedLibrary("me@example.test", [{ name: "a.txt", text: "alpha budget figures" }]);
    // A second installation of the same user, with its own folder.
    const other = await seedInstallation(one.user.id, { key: "other" });
    const account = await prisma.connectedAccount.findFirstOrThrow({ where: { userId: one.user.id } });
    const src = await prisma.knowledgeSource.create({
      data: { userId: one.user.id, installationId: other.id, accountId: account.id, folderId: "f2", folderName: "Other" },
    });
    const file = await prisma.knowledgeFile.create({
      data: { sourceId: src.id, externalId: "x", name: "other.txt", mimeType: "text/plain", revision: "r", status: "READY" },
    });
    const [vec] = await embedTexts(["other.txt\n\nalpha budget figures"], "document");
    await prisma.$executeRaw`
      INSERT INTO "KnowledgeChunk" (id, "fileId", "sourceId", ordinal, content, embedding)
      VALUES (gen_random_uuid()::text, ${file.id}, ${src.id}, 0, 'alpha budget figures', ${toVectorLiteral(vec)}::vector)`;

    const body = await (await call(one.key, { query: "alpha budget figures" })).json();
    expect(body.passages).toHaveLength(1);
    expect(body.passages[0].file.name).toBe("a.txt");
  });

  it("skips files that are not ready but reports them, so the agent can say so", async () => {
    const { key } = await seedLibrary("a@example.test", [
      { name: "done.txt", text: "finished content" },
      { name: "later.txt", text: "queued content", status: "PENDING" },
      { name: "broken.txt", text: "broken content", status: "FAILED" },
    ]);
    const body = await (await call(key, { query: "content" })).json();
    expect(body.passages.map((p: { file: { name: string } }) => p.file.name)).toEqual(["done.txt"]);
    expect(body.library.files).toMatchObject({ ready: 1, pending: 1, failed: 1 });
  });

  it("lists every searchable file, whatever the question matched, and only this installation's", async () => {
    const mine = await seedLibrary("me@example.test", [
      { name: "b.txt", text: "second file text" },
      { name: "a.txt", text: "first file text" },
      { name: "later.txt", text: "x", status: "PENDING" },
    ]);
    await seedLibrary("them@example.test", [{ name: "theirs.txt", text: "not mine" }]);
    const body = await (await call(mine.key, { query: "second", limit: 1 })).json();
    expect(body.passages).toHaveLength(1);
    expect(body.files).toEqual([
      { name: "a.txt", path: "Legal", url: "https://drive.example/a.txt" },
      { name: "b.txt", path: "Legal", url: "https://drive.example/b.txt" },
    ]);
  });

  it("answers with an empty library rather than an error when nothing is indexed yet", async () => {
    const { key } = await seedLibrary("a@example.test", [{ name: "later.txt", text: "x", status: "PENDING" }]);
    const body = await (await call(key, { query: "anything" })).json();
    expect(body.passages).toEqual([]);
    expect(body.files).toEqual([]);
    expect(body.context).toBe("");
    expect(body.library.files.pending).toBe(1);
  });

  it("flags a source waiting on a reconnect", async () => {
    const { key, source } = await seedLibrary("a@example.test", [{ name: "a.txt", text: "hello there" }]);
    await prisma.knowledgeSource.update({ where: { id: source.id }, data: { status: "NEEDS_RECONNECT" } });
    const body = await (await call(key, { query: "hello" })).json();
    expect(body.library.needsReconnect).toBe(true);
    expect(body.passages).toHaveLength(1); // stale beats nothing
  });

  it("clamps the limit", async () => {
    const files = Array.from({ length: 15 }, (_, i) => ({ name: `f${i}.txt`, text: `shared words number ${i}` }));
    const { key } = await seedLibrary("a@example.test", files);
    expect((await (await call(key, { query: "shared words", limit: 500 })).json()).passages).toHaveLength(12);
    expect((await (await call(key, { query: "shared words", limit: 0 })).json()).passages).toHaveLength(6);
    expect((await (await call(key, { query: "shared words", limit: 2 })).json()).passages).toHaveLength(2);
  });

  it("rate-limits a runaway workflow", async () => {
    const { key } = await seedLibrary("a@example.test", []);
    let last = 200;
    for (let i = 0; i < 61; i++) last = (await call(key, { query: "x" })).status;
    expect(last).toBe(429);
  });
});

describe("uninstalling", () => {
  it("kills the key and deletes the folders with everything read from them", async () => {
    const { user, installation, key, source } = await seedLibrary("a@example.test", [
      { name: "a.txt", text: "hello there" },
    ]);
    viewer.current = user;
    const form = new FormData();
    form.set("installationId", installation.id);
    form.set("confirmed", "yes");
    await uninstall(form);

    expect((await call(key, { query: "hello" })).status).toBe(401);
    expect(await prisma.knowledgeSource.count({ where: { id: source.id } })).toBe(0);
    expect(await prisma.knowledgeFile.count()).toBe(0);
    expect(await prisma.knowledgeChunk.count()).toBe(0);
  });
});
