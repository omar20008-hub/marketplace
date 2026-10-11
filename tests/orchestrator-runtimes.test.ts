import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { prisma } from "@/lib/db";
import { n8n } from "@/lib/n8n";
import type { Viewer } from "@/lib/auth";
import { runInstalledProduct } from "@/server/orchestrator/runtimes/product";

/**
 * The product runtime against a real database. Each case asks the same question the
 * Orchestrator asks: run this installation for this user, and tell the model what
 * came back. The dispatcher is spied on so that the cases can say exactly what it
 * replied, and so that a refused run can be shown never to reach it.
 */

const PLAN_ID = "test-plan";

async function wipe() {
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

async function makeUser(email: string, monthlyRuns = 100): Promise<Viewer> {
  await prisma.plan.upsert({
    where: { id: PLAN_ID },
    update: { monthlyRuns },
    create: {
      id: PLAN_ID,
      name: "Test",
      monthlyRuns,
      storageBytes: BigInt(1_000_000),
      monthlyCredits: 0,
    },
  });
  return prisma.user.create({
    data: { email, name: "Tester", passwordHash: "x", initials: "TE", planId: PLAN_ID },
    include: { plan: true },
  }) as unknown as Viewer;
}

async function makeInstalledProduct(
  userId: string,
  {
    inputSchema = [],
    requirements = [],
  }: {
    inputSchema?: unknown[];
    requirements?: {
      kind: "CONNECTION";
      label: string;
      credentialType: string | null;
      providedBy: "USER" | "PLATFORM";
    }[];
  } = {},
) {
  const product = await prisma.product.create({
    data: {
      slug: `p-${Math.random().toString(36).slice(2, 10)}`,
      creatorId: userId,
      title: "Weekly Digest",
      summary: "s",
      description: "d",
      needsFromYou: "n",
      kind: "WORKFLOW",
      category: "Reporting",
      actionType: "READ",
      status: "PUBLISHED",
      inputSchema: inputSchema as never,
      requirements: { create: requirements },
    },
  });
  return prisma.installation.create({
    data: {
      userId,
      productId: product.id,
      pinnedVersion: "1.0",
      status: "ACTIVE",
      installationId: `inst_${Math.random().toString(36).slice(2, 8)}`,
    },
  });
}

beforeEach(wipe);
afterEach(() => {
  vi.restoreAllMocks();
});
afterAll(async () => {
  await wipe();
  await prisma.$disconnect();
});

describe("runInstalledProduct", () => {
  it("returns the dispatcher's whole output, not the shortened copy kept on the run", async () => {
    const user = await makeUser("runtime-full@example.test");
    const installation = await makeInstalledProduct(user.id);
    const long = "س".repeat(3000);
    vi.spyOn(n8n, "dispatch").mockResolvedValue({ result: "success", toolOutput: long });

    const answer = JSON.parse(
      await runInstalledProduct({ user, installationId: installation.id, args: {} }),
    );

    expect(answer).toEqual({ result: "success", toolOutput: long });
  });

  it("passes an incomplete answer through with the fields it is missing", async () => {
    const user = await makeUser("runtime-incomplete@example.test");
    const installation = await makeInstalledProduct(user.id, {
      inputSchema: [{ name: "sheetUrl", label: "Sheet", type: "string", required: true }],
    });

    const answer = JSON.parse(
      await runInstalledProduct({ user, installationId: installation.id, args: {} }),
    );

    expect(answer.result).toBe("incomplete");
    expect(answer.missing).toContain("sheetUrl");
  });

  it("passes a denial from the dispatcher through unchanged", async () => {
    const user = await makeUser("runtime-denied@example.test");
    const installation = await makeInstalledProduct(user.id);
    vi.spyOn(n8n, "dispatch").mockResolvedValue({ result: "denied", reason: "not your workflow" });

    const answer = JSON.parse(
      await runInstalledProduct({ user, installationId: installation.id, args: {} }),
    );

    expect(answer).toEqual({ result: "denied", reason: "not your workflow" });
  });

  it("does not run another user's installation, and says it was not found", async () => {
    const owner = await makeUser("runtime-owner@example.test");
    const intruder = await makeUser("runtime-intruder@example.test");
    const theirs = await makeInstalledProduct(owner.id);
    const dispatch = vi.spyOn(n8n, "dispatch");

    const answer = JSON.parse(
      await runInstalledProduct({ user: intruder, installationId: theirs.id, args: {} }),
    );

    expect(answer).toEqual({ result: "denied", reason: "installation_not_found" });
    expect(dispatch).not.toHaveBeenCalled();
  });

  it("refuses before dispatch when a connection is missing, and charges nothing", async () => {
    const user = await makeUser("runtime-connection@example.test");
    const installation = await makeInstalledProduct(user.id, {
      requirements: [
        { kind: "CONNECTION", label: "Google Sheets", credentialType: "googleSheetsApi", providedBy: "USER" },
      ],
    });
    const dispatch = vi.spyOn(n8n, "dispatch");

    const answer = JSON.parse(
      await runInstalledProduct({ user, installationId: installation.id, args: {} }),
    );

    expect(answer.result).toBe("denied");
    expect(answer.reason).toContain("Google Sheets");
    expect(dispatch).not.toHaveBeenCalled();
    expect(await prisma.run.count({ where: { charged: true } })).toBe(0);
  });

  it("refuses before dispatch once the plan's runs are used up", async () => {
    const user = await makeUser("runtime-plan@example.test", 0);
    const installation = await makeInstalledProduct(user.id);
    const dispatch = vi.spyOn(n8n, "dispatch");

    const answer = JSON.parse(
      await runInstalledProduct({ user, installationId: installation.id, args: {} }),
    );

    expect(answer.result).toBe("denied");
    expect(answer.reason).toContain("runs");
    expect(dispatch).not.toHaveBeenCalled();
  });
});
