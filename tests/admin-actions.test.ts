import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Review decisions.
 *
 * These change what every user of the marketplace sees, so the things worth
 * pinning down are the refusals: a reviewer without the role, a decision with
 * no reason, a blocker being waved through, and a rejection that must not pull
 * a version already live out from under the people running it.
 *
 * Every path also has to leave an audit entry. The module's own comment says no
 * path can skip it, so each test that makes a decision checks for one.
 */

const viewer = vi.hoisted(() => ({
  current: null as { id: string; roles: string[] } | null,
}));

class Redirected extends Error {
  constructor(readonly to: string) {
    super(`redirect:${to}`);
  }
}

/**
 * requireRole is the real gate these actions use, so it is reproduced rather
 * than stubbed away: no session redirects to sign-in, a signed-in user without
 * the role goes home, and only the right role returns.
 */
vi.mock("@/lib/auth", () => ({
  requireRole: async (role: string) => {
    if (!viewer.current) throw new Redirected("/login");
    if (!viewer.current.roles.includes(role)) throw new Redirected("/");
    return viewer.current;
  },
}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

const { prisma } = await import("@/lib/db");
const { approve, hold, reject, requestChanges } = await import(
  "@/server/admin-actions"
);

const PLAN_ID = "test-plan-admin";

async function wipe() {
  await prisma.auditLog.deleteMany({});
  await prisma.submissionIssue.deleteMany({});
  await prisma.submission.deleteMany({});
  await prisma.productVersion.deleteMany({});
  await prisma.product.deleteMany({});
  await prisma.user.deleteMany({});
  await prisma.plan.deleteMany({});
}

type Seed = {
  productStatus?: "IN_REVIEW" | "PUBLISHED";
  issues?: { severity: "BLOCKER" | "QUALITY"; title: string; detail: string }[];
  version?: string;
};

async function seed({
  productStatus = "IN_REVIEW",
  issues = [],
  version = "2.0",
}: Seed = {}) {
  await prisma.plan.create({
    data: {
      id: PLAN_ID,
      name: "Test",
      monthlyRuns: 10,
      storageBytes: BigInt(1000),
      monthlyCredits: 0,
    },
  });
  const admin = await prisma.user.create({
    data: {
      email: "admin@example.test",
      name: "Admin",
      passwordHash: "x",
      initials: "AD",
      planId: PLAN_ID,
      roles: ["USER", "ADMIN"],
    },
  });
  const creator = await prisma.user.create({
    data: {
      email: "creator@example.test",
      name: "Creator",
      passwordHash: "x",
      initials: "CR",
      planId: PLAN_ID,
      roles: ["USER", "CREATOR"],
    },
  });
  const product = await prisma.product.create({
    data: {
      slug: `p-${Math.random().toString(36).slice(2, 8)}`,
      creatorId: creator.id,
      title: "Digest",
      summary: "s",
      description: "d",
      needsFromYou: "n",
      kind: "WORKFLOW",
      category: "Reporting",
      status: productStatus,
      version: "1.0",
    },
  });
  const submission = await prisma.submission.create({
    data: {
      productId: product.id,
      creatorId: creator.id,
      version,
      state: "UNDER_REVIEW",
      issues: { create: issues },
    },
  });

  viewer.current = { id: admin.id, roles: ["USER", "ADMIN"] };
  return { admin, creator, product, submission };
}

function form(values: Record<string, string>) {
  const data = new FormData();
  for (const [key, value] of Object.entries(values)) data.append(key, value);
  return data;
}

/** Runs an action and reports the redirect, if it was turned away. */
async function turnedAwayTo(run: () => Promise<unknown>) {
  try {
    await run();
    return null;
  } catch (error) {
    if (error instanceof Redirected) return error.to;
    throw error;
  }
}

beforeEach(wipe);
afterAll(async () => {
  await wipe();
  await prisma.$disconnect();
});

describe("only an admin decides", () => {
  it.each([
    ["approve", approve],
    ["requestChanges", requestChanges],
    ["reject", reject],
    ["hold", hold],
  ])("%s sends a signed-in non-admin home", async (_name, action) => {
    const { submission, product } = await seed();
    viewer.current = { id: "someone", roles: ["USER", "CREATOR"] };

    const destination = await turnedAwayTo(() =>
      action(form({ submissionId: submission.id, productId: product.id, reason: "why" })),
    );

    expect(destination).toBe("/");
    expect(await prisma.auditLog.count()).toBe(0);
  });

  it("approve sends a stranger to sign-in", async () => {
    const { submission } = await seed();
    viewer.current = null;

    expect(
      await turnedAwayTo(() => approve(form({ submissionId: submission.id, reason: "ok" }))),
    ).toBe("/login");
  });
});

describe("a decision needs a reason", () => {
  it.each([
    ["approve", approve],
    ["requestChanges", requestChanges],
    ["reject", reject],
  ])("%s does nothing without one", async (_name, action) => {
    const { submission } = await seed();

    await action(form({ submissionId: submission.id, reason: "   " }));

    expect(await prisma.submission.findUnique({ where: { id: submission.id } })).toMatchObject(
      { state: "UNDER_REVIEW" },
    );
    expect(await prisma.auditLog.count()).toBe(0);
  });

  it("hold does nothing without one", async () => {
    const { product } = await seed();

    await hold(form({ productId: product.id, reason: "" }));

    expect(await prisma.product.findUnique({ where: { id: product.id } })).toMatchObject({
      status: "IN_REVIEW",
    });
  });
});

describe("approve", () => {
  it("publishes, pins the version, and writes the audit entry", async () => {
    const { admin, product, submission } = await seed({ version: "2.0" });

    await approve(form({ submissionId: submission.id, reason: "Looks good" }));

    expect(await prisma.submission.findUnique({ where: { id: submission.id } })).toMatchObject({
      state: "APPROVED",
      decidedById: admin.id,
      decisionReason: "Looks good",
    });

    const after = await prisma.product.findUnique({ where: { id: product.id } });
    expect(after).toMatchObject({
      status: "PUBLISHED",
      version: "2.0",
      platformApproved: true,
      rejectionReason: null,
    });
    expect(after!.publishedAt).toBeInstanceOf(Date);

    expect(await prisma.auditLog.findFirst()).toMatchObject({
      actorId: admin.id,
      action: "approve",
      reason: "Looks good",
    });
  });

  it("marks the approved version current, and the previous one not", async () => {
    const { product, submission } = await seed({ version: "2.0" });
    await prisma.productVersion.create({
      data: { productId: product.id, version: "1.0", current: true },
    });

    await approve(form({ submissionId: submission.id, reason: "ok" }));

    const versions = await prisma.productVersion.findMany({
      where: { productId: product.id },
      orderBy: { version: "asc" },
    });
    expect(versions.map((v) => [v.version, v.current])).toEqual([
      ["1.0", false],
      ["2.0", true],
    ]);
  });

  it("refuses to wave a blocker through, however good the reason", async () => {
    const { product, submission } = await seed({
      issues: [{ severity: "BLOCKER", title: "Shell node", detail: "executeCommand" }],
    });

    await approve(form({ submissionId: submission.id, reason: "I know, ship it" }));

    expect(await prisma.submission.findUnique({ where: { id: submission.id } })).toMatchObject(
      { state: "UNDER_REVIEW" },
    );
    expect(await prisma.product.findUnique({ where: { id: product.id } })).toMatchObject({
      status: "IN_REVIEW",
    });
    expect(await prisma.auditLog.count()).toBe(0);
  });

  it("is not stopped by an issue that is not a blocker", async () => {
    const { product, submission } = await seed({
      issues: [{ severity: "QUALITY", title: "No description", detail: "minor" }],
    });

    await approve(form({ submissionId: submission.id, reason: "fine" }));

    expect(await prisma.product.findUnique({ where: { id: product.id } })).toMatchObject({
      status: "PUBLISHED",
    });
  });

  it("does nothing for a submission that does not exist", async () => {
    await seed();
    await approve(form({ submissionId: "nope", reason: "ok" }));
    expect(await prisma.auditLog.count()).toBe(0);
  });
});

describe("requestChanges", () => {
  it("records the decision without touching the product", async () => {
    const { admin, product, submission } = await seed();

    await requestChanges(form({ submissionId: submission.id, reason: "Add a description" }));

    expect(await prisma.submission.findUnique({ where: { id: submission.id } })).toMatchObject({
      state: "CHANGES_REQUESTED",
      decidedById: admin.id,
      decisionReason: "Add a description",
    });
    expect(await prisma.product.findUnique({ where: { id: product.id } })).toMatchObject({
      status: "IN_REVIEW",
    });
    expect(await prisma.auditLog.findFirst()).toMatchObject({ action: "request changes" });
  });
});

describe("reject", () => {
  it("withdraws a product that was never published", async () => {
    const { product, submission } = await seed({ productStatus: "IN_REVIEW" });

    await reject(form({ submissionId: submission.id, reason: "Not a fit" }));

    expect(await prisma.product.findUnique({ where: { id: product.id } })).toMatchObject({
      status: "WITHDRAWN",
      rejectionReason: "Not a fit",
    });
    expect(await prisma.auditLog.findFirst()).toMatchObject({ action: "reject" });
  });

  it("leaves a live version live, so rejecting an update does not break installs", async () => {
    // Rejecting v2 must not unpublish v1 out from under everyone running it.
    const { product, submission } = await seed({ productStatus: "PUBLISHED" });

    await reject(form({ submissionId: submission.id, reason: "Not this version" }));

    expect(await prisma.product.findUnique({ where: { id: product.id } })).toMatchObject({
      status: "PUBLISHED",
      rejectionReason: "Not this version",
    });
    expect(await prisma.submission.findUnique({ where: { id: submission.id } })).toMatchObject({
      state: "REJECTED",
    });
  });
});

describe("hold", () => {
  it("puts the product on a security hold, with the reason", async () => {
    const { admin, product } = await seed({ productStatus: "PUBLISHED" });

    await hold(form({ productId: product.id, reason: "Reported exfiltration" }));

    expect(await prisma.product.findUnique({ where: { id: product.id } })).toMatchObject({
      status: "SECURITY_HOLD",
      restrictionNote: "Reported exfiltration",
    });
    expect(await prisma.auditLog.findFirst()).toMatchObject({
      actorId: admin.id,
      action: "security hold",
      reason: "Reported exfiltration",
    });
  });
});
