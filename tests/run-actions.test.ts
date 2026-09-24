import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { prisma } from "@/lib/db";
import { executeRun } from "@/server/run-actions";
import type { Viewer } from "@/lib/auth";

/**
 * executeRun against a real database and the mock driver.
 *
 * The README's claim is that "every refusal happens here, before the dispatcher
 * is called, so a blocked run never costs the user anything". These tests are
 * about that boundary: what gets refused, what gets charged, and what the user
 * is told. Each case builds only the rows it needs and clears them first, so the
 * suite does not depend on the seed.
 */

const PLAN_ID = "test-plan";

async function wipe() {
  // Ordered by dependency; Run and Installation cascade from User.
  await prisma.artifact.deleteMany({});
  await prisma.runStep.deleteMany({});
  await prisma.run.deleteMany({});
  await prisma.installationCredential.deleteMany({});
  await prisma.installation.deleteMany({});
  await prisma.requirement.deleteMany({});
  await prisma.connectedAccount.deleteMany({});
  await prisma.product.deleteMany({});
  await prisma.user.deleteMany({});
  await prisma.plan.deleteMany({});
}

async function makeUser({ monthlyRuns = 100 } = {}) {
  await prisma.plan.create({
    data: {
      id: PLAN_ID,
      name: "Test",
      monthlyRuns,
      storageBytes: BigInt(1_000_000),
      monthlyCredits: 0,
    },
  });

  return prisma.user.create({
    data: {
      email: "tester@example.test",
      name: "Tester",
      passwordHash: "x",
      initials: "TE",
      planId: PLAN_ID,
    },
    include: { plan: true },
  });
}

type MakeProduct = {
  creatorId: string;
  status?: "PUBLISHED" | "SUSPENDED" | "RESTRICTED";
  requirements?: {
    kind: "CONNECTION";
    label: string;
    credentialType: string | null;
    providedBy: "USER" | "PLATFORM";
  }[];
  inputSchema?: unknown[];
  outputs?: unknown[];
};

async function makeProduct({
  creatorId,
  status = "PUBLISHED",
  requirements = [],
  inputSchema = [],
  outputs = [],
}: MakeProduct) {
  return prisma.product.create({
    data: {
      slug: `p-${Math.random().toString(36).slice(2, 8)}`,
      creatorId,
      title: "Weekly Digest",
      summary: "s",
      description: "d",
      needsFromYou: "n",
      kind: "WORKFLOW",
      category: "Reporting",
      actionType: "READ",
      status,
      inputSchema: inputSchema as never,
      outputs: outputs as never,
      requirements: { create: requirements },
    },
  });
}

async function install(userId: string, productId: string, extra = {}) {
  return prisma.installation.create({
    data: {
      userId,
      productId,
      pinnedVersion: "1.0",
      status: "ACTIVE",
      installationId: `inst_${Math.random().toString(36).slice(2, 8)}`,
      ...extra,
    },
  });
}

beforeEach(wipe);
afterAll(async () => {
  await wipe();
  await prisma.$disconnect();
});

describe("executeRun — refusals that cost nothing", () => {
  it("returns null for an installation that is not the caller's", async () => {
    const user = await makeUser();
    const other = await prisma.user.create({
      data: {
        email: "other@example.test",
        name: "Other",
        passwordHash: "x",
        initials: "OT",
        planId: PLAN_ID,
      },
    });
    const product = await makeProduct({ creatorId: user.id });
    const theirs = await install(other.id, product.id);

    const run = await executeRun({
      user: user as Viewer,
      installationId: theirs.id,
      args: {},
    });

    expect(run).toBeNull();
    // Nothing recorded against either user.
    expect(await prisma.run.count()).toBe(0);
  });

  it("blocks a run whose connection is missing, without charging", async () => {
    const user = await makeUser();
    const product = await makeProduct({
      creatorId: user.id,
      requirements: [
        {
          kind: "CONNECTION",
          label: "Slack",
          credentialType: "slackApi",
          providedBy: "USER",
        },
      ],
    });
    const installation = await install(user.id, product.id);

    const run = await executeRun({
      user: user as Viewer,
      installationId: installation.id,
      args: {},
    });

    expect(run).toMatchObject({
      result: "BLOCKED",
      errorType: "connection",
      charged: false,
      chargeNote: "not charged",
      durationMs: 0,
    });
    expect(run!.message).toContain("Slack");
  });

  it("blocks once the plan's monthly runs are used up", async () => {
    const user = await makeUser({ monthlyRuns: 1 });
    const product = await makeProduct({ creatorId: user.id });
    const installation = await install(user.id, product.id);

    const first = await executeRun({
      user: user as Viewer,
      installationId: installation.id,
      args: {},
    });
    expect(first).toMatchObject({ result: "SUCCESS", charged: true });

    const second = await executeRun({
      user: user as Viewer,
      installationId: installation.id,
      args: {},
    });

    expect(second).toMatchObject({
      result: "BLOCKED",
      errorType: "plan limit",
      charged: false,
    });
    expect(second!.message).toContain("1 of 1 runs");
  });

  it("does not count an uncharged run against the plan", async () => {
    // A blocked run must not consume the allowance that blocked it, or one
    // connection problem would eat the user's whole month.
    const user = await makeUser({ monthlyRuns: 2 });
    const blocked = await makeProduct({
      creatorId: user.id,
      requirements: [
        {
          kind: "CONNECTION",
          label: "Slack",
          credentialType: "slackApi",
          providedBy: "USER",
        },
      ],
    });
    const fine = await makeProduct({ creatorId: user.id });
    const blockedInstall = await install(user.id, blocked.id);
    const fineInstall = await install(user.id, fine.id);

    for (let i = 0; i < 3; i++) {
      await executeRun({
        user: user as Viewer,
        installationId: blockedInstall.id,
        args: {},
      });
    }

    const run = await executeRun({
      user: user as Viewer,
      installationId: fineInstall.id,
      args: {},
    });
    expect(run).toMatchObject({ result: "SUCCESS" });
  });

  it("refuses a suspended product even though it is installed", async () => {
    const user = await makeUser();
    const product = await makeProduct({ creatorId: user.id, status: "SUSPENDED" });
    const installation = await install(user.id, product.id);

    const run = await executeRun({
      user: user as Viewer,
      installationId: installation.id,
      args: {},
    });

    expect(run).toMatchObject({ result: "BLOCKED", charged: false });
  });

  it("records an incomplete run when a required input is missing", async () => {
    const user = await makeUser();
    const product = await makeProduct({
      creatorId: user.id,
      inputSchema: [{ name: "sheetUrl", label: "Sheet", required: true }],
    });
    const installation = await install(user.id, product.id);

    const run = await executeRun({
      user: user as Viewer,
      installationId: installation.id,
      args: {},
    });

    expect(run).toMatchObject({
      result: "INCOMPLETE",
      errorType: "missing input",
      charged: false,
    });
    expect(run!.message).toContain("sheetUrl");
  });
});

describe("executeRun — a run that works", () => {
  it("records a charged run with its steps", async () => {
    const user = await makeUser();
    const product = await makeProduct({ creatorId: user.id });
    const installation = await install(user.id, product.id);

    const run = await executeRun({
      user: user as Viewer,
      installationId: installation.id,
      args: { anything: "yes" },
    });

    expect(run).toMatchObject({ result: "SUCCESS", charged: true });
    const steps = await prisma.runStep.findMany({ where: { runId: run!.id } });
    expect(steps.length).toBeGreaterThan(0);
    expect(steps.every((s) => s.status === "DONE")).toBe(true);
  });

  it("writes a real file when the product declares an output", async () => {
    const user = await makeUser();
    const product = await makeProduct({
      creatorId: user.id,
      outputs: [{ name: "Digest", note: "a text file" }],
    });
    const installation = await install(user.id, product.id);

    const run = await executeRun({
      user: user as Viewer,
      installationId: installation.id,
      args: {},
    });

    const artifact = await prisma.artifact.findFirst({ where: { runId: run!.id } });
    expect(artifact).toBeTruthy();
    expect(artifact!.sizeBytes).toBeGreaterThan(0);
    expect(artifact!.path).toBe(`results/${artifact!.name}`);
  });

  it("produces no file when the product declares no output", async () => {
    const user = await makeUser();
    const product = await makeProduct({ creatorId: user.id });
    const installation = await install(user.id, product.id);

    const run = await executeRun({
      user: user as Viewer,
      installationId: installation.id,
      args: {},
    });

    expect(await prisma.artifact.count({ where: { runId: run!.id } })).toBe(0);
  });

  it("clears the failure count and stamps the last run", async () => {
    const user = await makeUser();
    const product = await makeProduct({ creatorId: user.id });
    const installation = await install(user.id, product.id, { failureCount: 3 });

    await executeRun({
      user: user as Viewer,
      installationId: installation.id,
      args: {},
    });

    const after = await prisma.installation.findUnique({
      where: { id: installation.id },
    });
    expect(after).toMatchObject({ failureCount: 0 });
    expect(after!.lastRunAt).toBeInstanceOf(Date);
  });

  it("gives every run its own handle", async () => {
    const user = await makeUser();
    const product = await makeProduct({ creatorId: user.id });
    const installation = await install(user.id, product.id);

    const runs = [];
    for (let i = 0; i < 5; i++) {
      runs.push(
        await executeRun({
          user: user as Viewer,
          installationId: installation.id,
          args: {},
        }),
      );
    }

    const handles = new Set(runs.map((r) => r!.runId));
    expect(handles.size).toBe(5);
  });

  it("passes the session's user id to the dispatcher, not anything from args", async () => {
    // The dispatcher's ownership check is only as good as this. A run that
    // smuggled a userId through args must not take effect.
    const user = await makeUser();
    const product = await makeProduct({
      creatorId: user.id,
      outputs: [{ name: "Digest", note: "n" }],
    });
    const installation = await install(user.id, product.id);

    const run = await executeRun({
      user: user as Viewer,
      installationId: installation.id,
      args: { userId: "someone-else" },
    });

    expect(run!.userId).toBe(user.id);
  });
});
