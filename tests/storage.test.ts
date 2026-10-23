import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The flag is read when the environment loads, so it is set before any import.
vi.hoisted(() => {
  process.env.STORAGE_DRIVER = "platform";
});

import { prisma } from "@/lib/db";
import { MAX_OBJECT_BYTES, storageOperation } from "@/server/storage";

/**
 * The platform's storage destination against the real database. The rules under
 * test are the ones the MP · Storage API enforced: active installations only, no
 * ".." in a path, and one installation never reads another's files.
 */

const PLAN_ID = "test-plan";

async function wipe() {
  await prisma.storageObject.deleteMany({});
  await prisma.installation.deleteMany({});
  await prisma.product.deleteMany({});
  await prisma.user.deleteMany({});
  await prisma.plan.deleteMany({});
}

async function makeInstallation(email: string, status: "ACTIVE" | "DISABLED" = "ACTIVE") {
  await prisma.plan.upsert({
    where: { id: PLAN_ID },
    update: {},
    create: { id: PLAN_ID, name: "Test", monthlyRuns: 100, storageBytes: BigInt(1_000_000), monthlyCredits: 0 },
  });
  const user = await prisma.user.create({
    data: { email, name: "Tester", passwordHash: "x", initials: "TE", planId: PLAN_ID },
  });
  const product = await prisma.product.create({
    data: {
      slug: `p-${Math.random().toString(36).slice(2, 10)}`,
      creatorId: user.id,
      title: "Digest",
      summary: "s",
      description: "d",
      needsFromYou: "n",
      kind: "WORKFLOW",
      category: "Reporting",
      actionType: "READ",
      status: "PUBLISHED",
    },
  });
  const installation = await prisma.installation.create({
    data: { userId: user.id, productId: product.id, pinnedVersion: "1.0", status, installationId: `inst_${email}` },
  });
  return { target: { id: installation.id, installationId: installation.installationId }, userId: user.id };
}

const text = (s: string) => Buffer.from(s, "utf8").toString("base64");

beforeEach(wipe);
afterEach(() => {
  vi.restoreAllMocks();
});
afterAll(async () => {
  await wipe();
  await prisma.$disconnect();
});

describe("storage on the platform", () => {
  it("stores a file and returns the same bytes on get", async () => {
    const { target } = await makeInstallation("st-roundtrip@example.test");

    const put = await storageOperation(target, { operation: "put", path: "results/a.txt", content: text("hello"), mimeType: "text/plain" });
    const got = await storageOperation(target, { operation: "get", path: "results/a.txt" });

    expect(put).toMatchObject({ ok: true, size: 5, objectRef: `platform://${target.id}/results/a.txt` });
    expect(got).toEqual({ ok: true, content: text("hello"), mimeType: "text/plain" });
  });

  it("overwrites a file written again at the same path", async () => {
    const { target } = await makeInstallation("st-overwrite@example.test");
    await storageOperation(target, { operation: "put", path: "a", content: text("one") });
    await storageOperation(target, { operation: "put", path: "a", content: text("two") });

    const got = await storageOperation(target, { operation: "get", path: "a" });
    expect(got).toMatchObject({ ok: true, content: text("two") });
  });

  it("lists the files under a prefix, sorted by path", async () => {
    const { target } = await makeInstallation("st-list@example.test");
    await storageOperation(target, { operation: "put", path: "results/b.txt", content: text("b") });
    await storageOperation(target, { operation: "put", path: "results/a.txt", content: text("aa") });
    await storageOperation(target, { operation: "put", path: "other/c.txt", content: text("c") });

    const listed = await storageOperation(target, { operation: "list", path: "results/" });

    expect(listed).toEqual({
      ok: true,
      count: 2,
      files: [
        { path: "results/a.txt", size: 2, mimeType: "application/octet-stream" },
        { path: "results/b.txt", size: 1, mimeType: "application/octet-stream" },
      ],
    });
  });

  it("deletes a file, after which it cannot be read", async () => {
    const { target } = await makeInstallation("st-delete@example.test");
    await storageOperation(target, { operation: "put", path: "gone", content: text("x") });

    const deleted = await storageOperation(target, { operation: "delete", path: "gone" });
    const after = await storageOperation(target, { operation: "get", path: "gone" });

    expect(deleted).toEqual({ ok: true, deleted: 1 });
    expect(after).toEqual({ ok: false, error: "الملف غير موجود" });
  });

  it("refuses a path that climbs out of the installation's folder, for every operation", async () => {
    const { target } = await makeInstallation("st-dots@example.test");
    for (const operation of ["put", "get", "delete"] as const) {
      const reply = await storageOperation(target, { operation, path: "../other", content: text("x") });
      expect(reply).toEqual({ ok: false, error: "مسار غير مسموح" });
    }
  });

  it("requires a path for a put", async () => {
    const { target } = await makeInstallation("st-empty@example.test");
    expect(await storageOperation(target, { operation: "put", path: "/", content: text("x") })).toEqual({
      ok: false,
      error: "المسار مطلوب",
    });
  });

  it("refuses every operation on an installation that is not active", async () => {
    const { target } = await makeInstallation("st-disabled@example.test", "DISABLED");
    const reply = await storageOperation(target, { operation: "get", path: "x" });
    expect(reply).toEqual({ ok: false, error: "تثبيت غير معروف أو موقوف" });
  });

  it("never returns another installation's file, even at the same path", async () => {
    const mine = await makeInstallation("st-mine@example.test");
    const theirs = await makeInstallation("st-theirs@example.test");
    await storageOperation(theirs.target, { operation: "put", path: "secret", content: text("theirs") });

    const reply = await storageOperation(mine.target, { operation: "get", path: "secret" });

    expect(reply).toEqual({ ok: false, error: "الملف غير موجود" });
  });

  it("refuses a file larger than the limit, and stores nothing", async () => {
    const { target } = await makeInstallation("st-large@example.test");
    const content = Buffer.alloc(MAX_OBJECT_BYTES + 1).toString("base64");

    const reply = await storageOperation(target, { operation: "put", path: "big", content });

    expect(reply).toEqual({ ok: false, error: "الملف أكبر من الحد المسموح" });
    expect(await prisma.storageObject.count()).toBe(0);
  });
});
