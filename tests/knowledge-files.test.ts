import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The parts of choosing and managing a folder that are decisions rather than
 * pixels: reading a pasted link, the folder-listing endpoint (whose Drive token
 * must stay on the server), attaching a folder while activating, and the rule
 * that a user can only act on their own sources.
 */

const viewer = vi.hoisted(() => ({ current: null as { id: string } | null }));
vi.mock("@/lib/auth", () => ({
  requireUser: async () => {
    if (!viewer.current) throw new Error("no session");
    return viewer.current;
  },
}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
class Redirected extends Error {
  constructor(readonly to: string) {
    super(`redirect:${to}`);
  }
}
vi.mock("next/navigation", () => ({
  redirect: (to: string) => {
    throw new Redirected(to);
  },
}));

const drive = vi.hoisted(() => ({
  folders: { root: [{ id: "f-contracts-0001", name: "Contracts" }] } as Record<string, { id: string; name: string }[]>,
  openable: new Set(["f-contracts-0001"]),
}));
vi.mock("@/server/google-account", () => ({
  getGoogleAccessToken: vi.fn(async () => "secret-drive-token"),
  saveGoogleConnection: vi.fn(),
}));
vi.mock("@/lib/drive", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/drive")>();
  return {
    ...actual,
    listFolders: vi.fn(async (_t: string, parent: string) => drive.folders[parent] ?? []),
    getFolder: vi.fn(async (_t: string, id: string) => {
      if (!drive.openable.has(id)) throw new actual.DriveError("nope", 404);
      return { id, name: "Contracts" };
    }),
    listTree: vi.fn(async () => ({ files: [], folders: ["f-contracts-0001"], truncated: false })),
  };
});
vi.mock("@/server/knowledge/watch", () => ({
  ensureWatch: vi.fn(),
  renewWatches: vi.fn(),
  stopWatch: vi.fn(async () => {}),
}));

const { prisma } = await import("@/lib/db");
const { parseFolderInput } = await import("@/lib/drive");
const { GET: folders } = await import("@/app/api/knowledge/folders/route");
const { activate } = await import("@/server/install-actions");
const { attachFolder, removeSource, syncNow, retryFile, tryFileNow, leaveOutFile, useFileAgain, tryFileAgain } = await import("@/server/knowledge/actions");
const { GOOGLE_DRIVE_CREDENTIAL } = await import("@/lib/google-oauth");
const { linkify } = await import("@/components/app/linkified");

const PLAN_ID = "test-plan-files";

async function wipe() {
  await prisma.knowledgeJob.deleteMany({});
  await prisma.knowledgeSource.deleteMany({});
  await prisma.installationCredential.deleteMany({});
  await prisma.installation.deleteMany({});
  await prisma.requirement.deleteMany({});
  await prisma.connectedAccount.deleteMany({});
  await prisma.product.deleteMany({});
  await prisma.user.deleteMany({});
  await prisma.plan.deleteMany({});
  await prisma.storageAdapter.deleteMany({});
}

async function seedUser(email: string, { drive: connected = true } = {}) {
  const user = await prisma.user.create({
    data: { email, name: email, passwordHash: "x", initials: "U", planId: PLAN_ID },
  });
  if (connected) {
    await prisma.connectedAccount.create({
      data: {
        userId: user.id,
        credentialType: GOOGLE_DRIVE_CREDENTIAL,
        displayName: "Google Drive",
        initials: "GD",
        accountRef: email,
        status: "ACTIVE",
      },
    });
  }
  viewer.current = user;
  return user;
}

async function seedProduct(creatorId: string, usesKnowledge = true) {
  return prisma.product.create({
    data: {
      slug: `p-${Math.random().toString(36).slice(2, 8)}`,
      creatorId,
      title: "Chat with your files",
      summary: "s",
      description: "d",
      needsFromYou: "n",
      kind: "WORKFLOW",
      category: "Knowledge",
      status: "PUBLISHED",
      templateId: `tpl_${Math.random().toString(36).slice(2, 8)}`,
      usesKnowledge,
    },
  });
}

async function submit(form: Record<string, string>) {
  const data = new FormData();
  for (const [k, v] of Object.entries(form)) data.append(k, v);
  try {
    return { redirectedTo: null as string | null, ...(await activate({}, data)) };
  } catch (error) {
    if (error instanceof Redirected) return { redirectedTo: error.to, error: undefined };
    throw error;
  }
}

beforeEach(async () => {
  await wipe();
  await prisma.plan.create({
    data: { id: PLAN_ID, name: "T", monthlyRuns: 100, storageBytes: BigInt(1e6), monthlyCredits: 0 },
  });
  await prisma.storageAdapter.create({
    data: { backend: "platform", displayName: "Platform storage", active: true },
  });
});
afterAll(async () => {
  await wipe();
  await prisma.$disconnect();
});

describe("parseFolderInput", () => {
  it("reads the shapes of link Drive produces, and a bare id", () => {
    const id = "1AbCdEfGhIjKlMnOpQrStUv";
    expect(parseFolderInput(`https://drive.google.com/drive/folders/${id}`)).toBe(id);
    expect(parseFolderInput(`https://drive.google.com/drive/folders/${id}?usp=sharing`)).toBe(id);
    expect(parseFolderInput(`https://drive.google.com/drive/u/1/folders/${id}`)).toBe(id);
    expect(parseFolderInput(`https://drive.google.com/open?id=${id}`)).toBe(id);
    expect(parseFolderInput(`  ${id}  `)).toBe(id);
  });
  it("refuses anything else", () => {
    expect(parseFolderInput("")).toBeNull();
    expect(parseFolderInput("my documents")).toBeNull();
    expect(parseFolderInput("https://example.com/x")).toBeNull();
  });
});

describe("GET /api/knowledge/folders", () => {
  const get = (qs: string) => folders(new Request(`https://app.example.test/api/knowledge/folders${qs}`));

  it("lists folders without ever returning the Drive token", async () => {
    await seedUser("a@example.test");
    const res = await get("?parent=root");
    const text = await res.text();
    expect(res.status).toBe(200);
    expect(JSON.parse(text).folders).toEqual([{ id: "f-contracts-0001", name: "Contracts" }]);
    expect(text).not.toContain("secret-drive-token");
  });

  it("says so when Drive is not connected", async () => {
    await seedUser("a@example.test", { drive: false });
    const res = await get("?parent=root");
    expect(res.status).toBe(409);
    expect((await res.json()).error).toBe("not_connected");
  });

  it("resolves a pasted link, and rejects text that is not one", async () => {
    await seedUser("a@example.test");
    const ok = await get(`?resolve=${encodeURIComponent("https://drive.google.com/drive/folders/f-contracts-0001")}`);
    expect((await ok.json()).folder).toEqual({ id: "f-contracts-0001", name: "Contracts" });
    expect((await get("?resolve=hello")).status).toBe(400);
    expect((await get(`?resolve=${encodeURIComponent("https://drive.google.com/drive/folders/unknown-folder-1")}`)).status).toBe(404);
  });

  it("does not pass a hostile parent to the Drive query", async () => {
    await seedUser("a@example.test");
    expect((await get(`?parent=${encodeURIComponent("x' or 'a'='a")}`)).status).toBe(400);
  });
});

describe("activate with a folder", () => {
  it("attaches the chosen folder to the new installation and starts syncing it", async () => {
    const user = await seedUser("a@example.test");
    const product = await seedProduct(user.id);
    const res = await submit({ productId: product.id, storageBackend: "platform", knowledgeFolderId: "f-contracts-0001" });
    expect(res.redirectedTo).toBe("/workspace");
    const installation = await prisma.installation.findFirstOrThrow();
    const source = await prisma.knowledgeSource.findFirstOrThrow();
    expect(source).toMatchObject({ installationId: installation.id, folderId: "f-contracts-0001", userId: user.id });
    expect((await prisma.knowledgeJob.findFirstOrThrow()).kind).toBe("SYNC_SOURCE");
  });

  it("refuses a folder the account cannot open, before installing anything", async () => {
    const user = await seedUser("a@example.test");
    const product = await seedProduct(user.id);
    const res = await submit({ productId: product.id, storageBackend: "platform", knowledgeFolderId: "not-openable-1" });
    expect(res.error).toMatch(/could not be opened/);
    expect(await prisma.installation.count()).toBe(0);
  });

  it("asks for a Drive connection when a folder is chosen without one", async () => {
    const user = await seedUser("a@example.test", { drive: false });
    const product = await seedProduct(user.id);
    const res = await submit({ productId: product.id, storageBackend: "platform", knowledgeFolderId: "f-contracts-0001" });
    expect(res.error).toMatch(/Connect your Google Drive/);
  });

  it("installs without a folder when none is chosen, and ignores a folder sent for a product that has no files", async () => {
    const user = await seedUser("a@example.test");
    const plain = await seedProduct(user.id, false);
    await submit({ productId: plain.id, storageBackend: "platform", knowledgeFolderId: "f-contracts-0001" });
    expect(await prisma.knowledgeSource.count()).toBe(0);
    const files = await seedProduct(user.id);
    expect((await submit({ productId: files.id, storageBackend: "platform" })).redirectedTo).toBe("/workspace");
    expect(await prisma.knowledgeSource.count()).toBe(0);
  });
});

describe("managing a source", () => {
  async function seedSource(email: string) {
    const user = await seedUser(email);
    const product = await seedProduct(user.id);
    const installation = await prisma.installation.create({
      data: { userId: user.id, productId: product.id, pinnedVersion: "1.0", status: "ACTIVE" },
    });
    const account = await prisma.connectedAccount.findFirstOrThrow({ where: { userId: user.id } });
    const source = await prisma.knowledgeSource.create({
      data: { userId: user.id, installationId: installation.id, accountId: account.id, folderId: "f-contracts-0001", folderName: "Contracts" },
    });
    return { user, installation, source };
  }
  const form = (fields: Record<string, string>) => {
    const f = new FormData();
    for (const [k, v] of Object.entries(fields)) f.set(k, v);
    return f;
  };

  it("attaches a folder from the files page", async () => {
    const user = await seedUser("a@example.test");
    const product = await seedProduct(user.id);
    const installation = await prisma.installation.create({
      data: { userId: user.id, productId: product.id, pinnedVersion: "1.0", status: "ACTIVE" },
    });
    const state = await attachFolder({}, form({ installationId: installation.id, folderId: "f-contracts-0001" }));
    expect(state.error).toBeUndefined();
    expect(await prisma.knowledgeSource.count()).toBe(1);
    expect((await attachFolder({}, form({ installationId: installation.id, folderId: "" }))).error).toMatch(/Choose a folder/);
  });

  it("removes a folder together with what was read from it", async () => {
    const { source } = await seedSource("a@example.test");
    const file = await prisma.knowledgeFile.create({
      data: { sourceId: source.id, externalId: "x", name: "n", mimeType: "text/plain", revision: "r", status: "READY" },
    });
    await prisma.$executeRaw`
      INSERT INTO "KnowledgeChunk" (id, "fileId", "sourceId", ordinal, content)
      VALUES (gen_random_uuid()::text, ${file.id}, ${source.id}, 0, 'x')`;
    await removeSource(form({ sourceId: source.id }));
    expect(await prisma.knowledgeSource.count()).toBe(0);
    expect(await prisma.knowledgeFile.count()).toBe(0);
    expect(await prisma.knowledgeChunk.count()).toBe(0);
  });

  it("will not let one user act on another's source", async () => {
    const { source } = await seedSource("owner@example.test");
    await seedUser("intruder@example.test");
    await removeSource(form({ sourceId: source.id }));
    await syncNow(form({ sourceId: source.id }));
    expect(await prisma.knowledgeSource.count()).toBe(1);
    expect(await prisma.knowledgeJob.count()).toBe(0);
  });

  it("queues a check, but not for a paused source", async () => {
    const { source } = await seedSource("a@example.test");
    await syncNow(form({ sourceId: source.id }));
    expect(await prisma.knowledgeJob.count()).toBe(1);
    await prisma.knowledgeJob.deleteMany({});
    await prisma.knowledgeSource.update({ where: { id: source.id }, data: { status: "PAUSED" } });
    await syncNow(form({ sourceId: source.id }));
    expect(await prisma.knowledgeJob.count()).toBe(0);
  });

  it("retries only a failed file, and only the owner's", async () => {
    const { source } = await seedSource("a@example.test");
    const failed = await prisma.knowledgeFile.create({
      data: { sourceId: source.id, externalId: "f", name: "f", mimeType: "text/plain", revision: "r", status: "FAILED", error: "boom" },
    });
    const ready = await prisma.knowledgeFile.create({
      data: { sourceId: source.id, externalId: "g", name: "g", mimeType: "text/plain", revision: "r", status: "READY" },
    });
    await retryFile(form({ fileId: ready.id }));
    expect(await prisma.knowledgeJob.count()).toBe(0);
    await retryFile(form({ fileId: failed.id }));
    expect((await prisma.knowledgeFile.findUniqueOrThrow({ where: { id: failed.id } })).status).toBe("PENDING");
    expect(await prisma.knowledgeJob.count()).toBe(1);
  });
});

describe("trying a waiting file now", () => {
  async function waitingFile(email: string) {
    const user = await seedUser(email);
    const product = await seedProduct(user.id);
    const installation = await prisma.installation.create({
      data: { userId: user.id, productId: product.id, pinnedVersion: "1.0", status: "ACTIVE" },
    });
    const account = await prisma.connectedAccount.findFirstOrThrow({ where: { userId: user.id } });
    const source = await prisma.knowledgeSource.create({
      data: { userId: user.id, installationId: installation.id, accountId: account.id, folderId: "f-contracts-0001", folderName: "Contracts" },
    });
    const file = await prisma.knowledgeFile.create({
      data: { sourceId: source.id, externalId: "w", name: "w.pdf", mimeType: "application/pdf", revision: "r", status: "PENDING", error: "limiting requests" },
    });
    // The queue has it backing off for the best part of an hour, 7 attempts in.
    await prisma.knowledgeJob.create({
      data: { kind: "INDEX_FILE", targetId: file.id, dedupeKey: `INDEX_FILE:${file.id}`, attempts: 7, runAfter: new Date(Date.now() + 50 * 60_000) },
    });
    return { user, source, file };
  }
  const form = (fields: Record<string, string>) => {
    const f = new FormData();
    for (const [k, v] of Object.entries(fields)) f.set(k, v);
    return f;
  };
  const job = (fileId: string) => prisma.knowledgeJob.findUniqueOrThrow({ where: { dedupeKey: `INDEX_FILE:${fileId}` } });

  it("brings the retry forward and counts its attempts afresh", async () => {
    const { user, file } = await waitingFile("a@example.test");
    viewer.current = user;
    await tryFileNow(form({ fileId: file.id }));
    const after = await job(file.id);
    expect(after.attempts).toBe(0);
    expect(after.runAfter.getTime()).toBeLessThanOrEqual(Date.now());
  });

  it("is also what Check now does for the folder's waiting files", async () => {
    const { user, source, file } = await waitingFile("a@example.test");
    viewer.current = user;
    await syncNow(form({ sourceId: source.id }));
    expect((await job(file.id)).runAfter.getTime()).toBeLessThanOrEqual(Date.now());
  });

  it("leaves a job alone that is running right now, and other people's files", async () => {
    const { file } = await waitingFile("a@example.test");
    await prisma.knowledgeJob.update({ where: { dedupeKey: `INDEX_FILE:${file.id}` }, data: { leasedUntil: new Date(Date.now() + 60_000) } });
    const other = await seedUser("b@example.test");
    viewer.current = other;
    await tryFileNow(form({ fileId: file.id }));
    const untouched = await job(file.id);
    expect(untouched.attempts).toBe(7);
    expect(untouched.runAfter.getTime()).toBeGreaterThan(Date.now() + 40 * 60_000);

    const owner = await prisma.user.findFirstOrThrow({ where: { email: "a@example.test" } });
    viewer.current = owner;
    await tryFileNow(form({ fileId: file.id }));
    expect((await job(file.id)).attempts).toBe(7); // still running: not interrupted
  });
});

describe("leaving a file out", () => {
  async function readyFile(email: string) {
    const user = await seedUser(email);
    const product = await seedProduct(user.id);
    const installation = await prisma.installation.create({
      data: { userId: user.id, productId: product.id, pinnedVersion: "1.0", status: "ACTIVE" },
    });
    const account = await prisma.connectedAccount.findFirstOrThrow({ where: { userId: user.id } });
    const source = await prisma.knowledgeSource.create({
      data: { userId: user.id, installationId: installation.id, accountId: account.id, folderId: "f-contracts-0001", folderName: "Contracts" },
    });
    const file = await prisma.knowledgeFile.create({
      data: { sourceId: source.id, externalId: "x", name: "x.pdf", mimeType: "application/pdf", revision: "r1", status: "READY", chunkCount: 1, indexedRevision: "r1" },
    });
    await prisma.$executeRaw`INSERT INTO "KnowledgeChunk" (id, "fileId", "sourceId", ordinal, content) VALUES (gen_random_uuid()::text, ${file.id}, ${source.id}, 0, 'garbage')`;
    return { user, source, file };
  }
  const form = (fields: Record<string, string>) => {
    const f = new FormData();
    for (const [k, v] of Object.entries(fields)) f.set(k, v);
    return f;
  };

  it("deletes what was read from it, keeps it out, and is undone by Use again", async () => {
    const { user, file } = await readyFile("a@example.test");
    viewer.current = user;
    await leaveOutFile(form({ fileId: file.id }));
    let row = await prisma.knowledgeFile.findUniqueOrThrow({ where: { id: file.id } });
    expect(row).toMatchObject({ status: "UNSUPPORTED", chunkCount: 0, error: "Left out because you chose to." });
    expect(await prisma.knowledgeChunk.count({ where: { fileId: file.id } })).toBe(0);

    await useFileAgain(form({ fileId: file.id }));
    row = await prisma.knowledgeFile.findUniqueOrThrow({ where: { id: file.id } });
    expect(row).toMatchObject({ status: "PENDING", error: null });
    expect(await prisma.knowledgeJob.count({ where: { dedupeKey: `INDEX_FILE:${file.id}` } })).toBe(1);
  });

  it("only the owner can, and Use again is only for a file the owner left out", async () => {
    const { user, file } = await readyFile("a@example.test");
    const other = await seedUser("b@example.test");
    viewer.current = other;
    await leaveOutFile(form({ fileId: file.id }));
    expect((await prisma.knowledgeFile.findUniqueOrThrow({ where: { id: file.id } })).status).toBe("READY");

    viewer.current = user;
    await prisma.knowledgeFile.update({ where: { id: file.id }, data: { status: "UNSUPPORTED", error: "This file type cannot be read yet." } });
    await useFileAgain(form({ fileId: file.id }));
    expect((await prisma.knowledgeFile.findUniqueOrThrow({ where: { id: file.id } })).status).toBe("UNSUPPORTED");
  });
});

describe("trying a skipped file again", () => {
  async function skipped(email: string, error: string) {
    const user = await seedUser(email);
    const product = await seedProduct(user.id);
    const installation = await prisma.installation.create({
      data: { userId: user.id, productId: product.id, pinnedVersion: "1.0", status: "ACTIVE" },
    });
    const account = await prisma.connectedAccount.findFirstOrThrow({ where: { userId: user.id } });
    const source = await prisma.knowledgeSource.create({
      data: { userId: user.id, installationId: installation.id, accountId: account.id, folderId: "f-contracts-0001", folderName: "Contracts" },
    });
    const file = await prisma.knowledgeFile.create({
      data: { sourceId: source.id, externalId: "s", name: "s.csv", mimeType: "text/csv", revision: "r1", status: "UNSUPPORTED", error, indexedRevision: "r1" },
    });
    return { user, file };
  }
  const form = (id: string) => {
    const f = new FormData();
    f.set("fileId", id);
    return f;
  };

  it("queues a file skipped as unreadable, once the reader may have improved", async () => {
    const { user, file } = await skipped("a@example.test", "The text in this file is unreadable (a scan or an unusual font). Use a copy that has real text, such as an OCR version.");
    viewer.current = user;
    await tryFileAgain(form(file.id));
    const row = await prisma.knowledgeFile.findUniqueOrThrow({ where: { id: file.id } });
    expect(row).toMatchObject({ status: "PENDING", error: null, indexedRevision: null });
    expect(await prisma.knowledgeJob.count({ where: { dedupeKey: `INDEX_FILE:${file.id}` } })).toBe(1);
  });

  it("leaves alone what reading again cannot change: left out on purpose, scratch files, unreadable types, someone else's", async () => {
    for (const error of ["Left out because you chose to.", "A temporary file, so it is not indexed.", "This file type cannot be read yet."]) {
      await prisma.knowledgeJob.deleteMany({});
      await prisma.knowledgeFile.deleteMany({});
      await prisma.knowledgeSource.deleteMany({});
      await prisma.installation.deleteMany({});
      await prisma.product.deleteMany({});
      await prisma.connectedAccount.deleteMany({});
      await prisma.user.deleteMany({});
      const { user, file } = await skipped(`${Math.random().toString(36).slice(2)}@example.test`, error);
      viewer.current = user;
      await tryFileAgain(form(file.id));
      expect((await prisma.knowledgeFile.findUniqueOrThrow({ where: { id: file.id } })).status).toBe("UNSUPPORTED");
      expect(await prisma.knowledgeJob.count()).toBe(0);
    }
    const { file } = await skipped("owner@example.test", "The file is empty.");
    viewer.current = await seedUser("other@example.test");
    await tryFileAgain(form(file.id));
    expect((await prisma.knowledgeFile.findUniqueOrThrow({ where: { id: file.id } })).status).toBe("UNSUPPORTED");
  });
});

describe("linkify", () => {
  const anchors = (nodes: unknown[]) =>
    nodes.filter((n): n is { props: { href: string; children: string } } => typeof n === "object" && n !== null) as { props: { href: string; children: string } }[];

  it("links markdown links and bare urls, keeping the text around them", () => {
    const out = linkify("See [terms.pdf](https://drive.google.com/x) or https://example.com/a.");
    const links = anchors(out);
    expect(links.map((l) => [l.props.href, l.props.children])).toEqual([
      ["https://drive.google.com/x", "terms.pdf"],
      ["https://example.com/a", "https://example.com/a"],
    ]);
    expect(out.filter((n) => typeof n === "string").join("")).toBe("See  or .");
  });

  it("never turns a non-http address into a link", () => {
    const out = linkify("[click](javascript:alert(1)) and [x](data:text/html,hi)");
    expect(anchors(out)).toHaveLength(0);
  });
});
