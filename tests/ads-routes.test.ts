import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { prisma } from "@/lib/db";
import { newKnowledgeKey } from "@/server/knowledge/keys";
import { POST as create } from "@/app/api/ads/campaigns/route";
import { POST as activate } from "@/app/api/ads/campaigns/[id]/activate/route";

/**
 * The two calls the installed Ads workflow makes: create (returns the review) and
 * activate (needs the confirmed amount). Both answer only to the installation's
 * own key, and act only for that installation's owner.
 */

const PLAN_ID = "test-plan-ads-routes";

async function wipe() {
  await prisma.adCampaign.deleteMany({});
  await prisma.installation.deleteMany({});
  await prisma.product.deleteMany({});
  await prisma.connector.deleteMany({});
  await prisma.user.deleteMany({});
  await prisma.plan.deleteMany({});
}

async function seed() {
  await prisma.plan.create({
    data: { id: PLAN_ID, name: "T", monthlyRuns: 1, storageBytes: BigInt(1), monthlyCredits: 0 },
  });
  const user = await prisma.user.create({
    data: { email: "routes@example.test", name: "R", passwordHash: "x", initials: "R", planId: PLAN_ID },
  });
  const product = await prisma.product.create({
    data: {
      slug: `ads-${Math.random().toString(36).slice(2, 8)}`,
      creatorId: user.id,
      title: "Ads",
      summary: "s",
      description: "d",
      needsFromYou: "n",
      kind: "WORKFLOW",
      category: "Marketing",
      status: "PUBLISHED",
      inputSchema: [] as never,
    },
  });
  const { key, hash } = newKnowledgeKey();
  await prisma.installation.create({
    data: {
      userId: user.id,
      productId: product.id,
      pinnedVersion: "1.0",
      status: "ACTIVE",
      installationId: `inst_${Math.random().toString(36).slice(2, 8)}`,
      knowledgeKeyHash: hash,
    },
  });
  return { user, key };
}

const json = (body: unknown, key?: string) =>
  new Request("https://app.example.test/api/ads/campaigns", {
    method: "POST",
    headers: { "content-type": "application/json", ...(key ? { authorization: `Bearer ${key}` } : {}) },
    body: JSON.stringify(body),
  });

beforeEach(wipe);
afterAll(async () => {
  await wipe();
  await prisma.$disconnect();
});

describe("POST /api/ads/campaigns", () => {
  it("refuses a request without the installation's key", async () => {
    const response = await create(json({}));
    expect(response.status).toBe(401);
  });

  it("refuses a request whose body is not a campaign", async () => {
    const { key } = await seed();
    const response = await create(json({ name: "x" }, key));
    expect(response.status).toBe(400);
    expect((await response.json()).errors.length).toBeGreaterThan(0);
  });
});

describe("POST /api/ads/campaigns/[id]/activate", () => {
  it("refuses without the installation's key", async () => {
    const response = await activate(
      new Request("https://app.example.test/api/ads/campaigns/x/activate", { method: "POST", body: "{}" }),
      { params: Promise.resolve({ id: "x" }) },
    );
    expect(response.status).toBe(401);
  });

  it("requires a whole confirmed amount", async () => {
    const { key } = await seed();
    const response = await activate(
      new Request("https://app.example.test/api/ads/campaigns/x/activate", {
        method: "POST",
        headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
        body: JSON.stringify({ confirmedMaxTotalCents: 12.5 }),
      }),
      { params: Promise.resolve({ id: "x" }) },
    );
    expect(response.status).toBe(400);
  });

  it("does not switch on a campaign that belongs to another user", async () => {
    const { key } = await seed();
    const response = await activate(
      new Request("https://app.example.test/api/ads/campaigns/not-mine/activate", {
        method: "POST",
        headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
        body: JSON.stringify({ confirmedMaxTotalCents: 1500 }),
      }),
      { params: Promise.resolve({ id: "not-mine" }) },
    );
    expect(response.status).toBe(409);
    expect((await response.json()).errors[0]).toMatch(/not found/);
  });
});

