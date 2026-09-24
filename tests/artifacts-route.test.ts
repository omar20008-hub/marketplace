import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Serving a stored result.
 *
 * Every server action in this codebase has a test that points it at another
 * user's row and expects nothing to happen, because an action is reachable by
 * direct POST whether or not the button that calls it is on screen. This route
 * is the same rule reached a different way — by typing a URL — and until now it
 * was the one place the rule was only checked in a browser. An artifact id in a
 * link that gets forwarded, a log, a bookmark: the id is the least private thing
 * about a file, so the ownership check has to be against the session.
 */

class Redirected extends Error {
  constructor(readonly to: string) {
    super(`redirect:${to}`);
  }
}

const viewer = vi.hoisted(() => ({ current: null as { id: string } | null }));
vi.mock("@/lib/auth", () => ({
  requireUser: async () => {
    if (!viewer.current) throw new Redirected("/login");
    return viewer.current;
  },
}));

const { prisma } = await import("@/lib/db");
const { n8n } = await import("@/lib/n8n");
const { GET } = await import("@/app/api/artifacts/[id]/route");

const PLAN_ID = "test-plan-artifacts";

function call(id: string, query = "") {
  return GET(new Request(`http://localhost/api/artifacts/${id}${query}`), {
    params: Promise.resolve({ id }),
  });
}

async function wipe() {
  await prisma.artifact.deleteMany({});
  await prisma.runStep.deleteMany({});
  await prisma.run.deleteMany({});
  await prisma.installation.deleteMany({});
  await prisma.product.deleteMany({});
  await prisma.user.deleteMany({});
  await prisma.plan.deleteMany({});
}

/** A user with one installation, one run and one artifact whose bytes exist. */
async function makeOwnerWithFile(email: string, body: string, name = "report.txt") {
  await prisma.plan.upsert({
    where: { id: PLAN_ID },
    create: {
      id: PLAN_ID,
      name: "Test",
      monthlyRuns: 100,
      storageBytes: BigInt(1_000_000),
      monthlyCredits: 0,
    },
    update: {},
  });

  const user = await prisma.user.create({
    data: {
      email,
      name: "Tester",
      passwordHash: "x",
      initials: "TE",
      planId: PLAN_ID,
    },
  });

  const product = await prisma.product.create({
    data: {
      slug: `p-${user.id}`,
      creatorId: user.id,
      title: "A product",
      summary: "one line",
      description: "what it does",
      needsFromYou: "nothing",
      kind: "WORKFLOW",
      category: "Sales",
      status: "PUBLISHED",
    },
  });

  const installation = await prisma.installation.create({
    data: {
      installationId: `inst_${user.id}`,
      userId: user.id,
      productId: product.id,
      pinnedVersion: "1.0",
      status: "ACTIVE",
    },
  });

  const run = await prisma.run.create({
    data: {
      runId: `r-${user.id}`.slice(0, 20),
      userId: user.id,
      installationId: installation.id,
      productId: product.id,
      productVersion: "1.0",
      result: "SUCCESS",
    },
  });

  const path = `results/${name}`;
  // Put the bytes where the route will look for them.
  await n8n.storage({
    installationId: installation.installationId!,
    operation: "put",
    path,
    content: Buffer.from(body).toString("base64"),
    mimeType: "text/plain",
  });

  const artifact = await prisma.artifact.create({
    data: {
      runId: run.id,
      name,
      path,
      mimeType: "text/plain",
      sizeBytes: body.length,
      objectRef: `platform://${installation.installationId}/${path}`,
    },
  });

  return { user, artifact };
}

beforeEach(async () => {
  viewer.current = null;
  await wipe();
});

afterAll(async () => {
  await wipe();
  await prisma.$disconnect();
});

describe("who may read it", () => {
  it("sends a signed-out visitor to the sign-in page", async () => {
    const { artifact } = await makeOwnerWithFile("nora@acme.co", "hello");

    await expect(call(artifact.id)).rejects.toThrow(Redirected);
  });

  it("gives the owner the bytes", async () => {
    const { user, artifact } = await makeOwnerWithFile("nora@acme.co", "hello");
    viewer.current = { id: user.id };

    const response = await call(artifact.id);

    expect(response.status).toBe(200);
    await expect(response.text()).resolves.toBe("hello");
  });

  it("answers 404 for someone else's artifact, not 403", async () => {
    // 403 would confirm the id names a real file. 404 says only that this
    // person has no such artifact, which is the whole truth they are owed.
    const { artifact } = await makeOwnerWithFile("nora@acme.co", "secret");
    const other = await makeOwnerWithFile("rami@studio.co", "theirs");
    viewer.current = { id: other.user.id };

    const response = await call(artifact.id);

    expect(response.status).toBe(404);
    await expect(response.text()).resolves.not.toContain("secret");
  });

  it("answers 404 for an id that does not exist", async () => {
    const { user } = await makeOwnerWithFile("nora@acme.co", "hello");
    viewer.current = { id: user.id };

    expect((await call("no-such-artifact")).status).toBe(404);
  });
});

describe("what it sends", () => {
  it("uses the type storage reports", async () => {
    const { user, artifact } = await makeOwnerWithFile("nora@acme.co", "hello");
    viewer.current = { id: user.id };

    const response = await call(artifact.id);
    expect(response.headers.get("content-type")).toBe("text/plain");
  });

  it("shows the file inline, and attaches it only when asked", async () => {
    const { user, artifact } = await makeOwnerWithFile("nora@acme.co", "hello");
    viewer.current = { id: user.id };

    const inline = await call(artifact.id);
    const attached = await call(artifact.id, "?download");

    expect(inline.headers.get("content-disposition")).toMatch(/^inline;/);
    expect(attached.headers.get("content-disposition")).toMatch(/^attachment;/);
    expect(attached.headers.get("content-disposition")).toContain('filename="report.txt"');
  });

  it("is never cached, because a shared cache would serve it to the next person", async () => {
    const { user, artifact } = await makeOwnerWithFile("nora@acme.co", "hello");
    viewer.current = { id: user.id };

    const response = await call(artifact.id);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
  });

  it("says plainly when the row describes a file storage does not have", async () => {
    // Seeded results describe runs from before this instance existed. A clear
    // 404 is the honest answer; a fabricated file would not be.
    const { user } = await makeOwnerWithFile("nora@acme.co", "hello");
    viewer.current = { id: user.id };

    const run = await prisma.run.findFirstOrThrow({ where: { userId: user.id } });
    const orphan = await prisma.artifact.create({
      data: {
        runId: run.id,
        name: "missing.csv",
        path: "results/never-written.csv",
        mimeType: "text/csv",
        sizeBytes: 42,
        objectRef: "platform://nowhere",
      },
    });

    const response = await call(orphan.id);

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toMatchObject({
      error: "This file is not in storage.",
      artifact: { name: "missing.csv", size: 42 },
    });
  });
});
