import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { prisma } from "@/lib/db";
import { sealCredential } from "@/lib/secrets";
import { reviewCampaign, runDays } from "@/lib/ads/review";
import { activateAdCampaign } from "@/server/ads/activate";

/**
 * Switching a paused campaign on: the confirmed ceiling has to match, a campaign
 * that ended is refused, and a Meta refusal part-way pauses everything again.
 * Meta is a stub, so nothing is spent.
 */

const NOW = new Date("2026-10-11T08:00:00.000Z");
const PLAN_ID = "test-plan-activate";
const TOKEN = "EAA-test-activate-token";

async function wipe() {
  await prisma.adCampaign.deleteMany({});
  await prisma.connector.deleteMany({});
  await prisma.user.deleteMany({});
  await prisma.plan.deleteMany({});
}

async function seed(over: Partial<{ status: "PAUSED" | "ACTIVE"; endsAt: Date; withIds: boolean; connected: boolean }> = {}) {
  await prisma.plan.create({
    data: { id: PLAN_ID, name: "T", monthlyRuns: 1, storageBytes: BigInt(1), monthlyCredits: 0 },
  });
  const user = await prisma.user.create({
    data: { email: "act@example.test", name: "A", passwordHash: "x", initials: "A", planId: PLAN_ID },
  });
  if (over.connected !== false) {
    await prisma.connector.create({
      data: {
        userId: user.id,
        credentialType: "facebookGraphApi",
        displayName: "Facebook & Instagram",
        initials: "FB",
        accountRef: "Nora · Acme",
        status: "ACTIVE",
        secretJson: sealCredential({ accessToken: TOKEN }),
      },
    });
  }
  const campaign = await prisma.adCampaign.create({
    data: {
      userId: user.id,
      adAccountId: "act_1234567890",
      name: "Autumn launch",
      objective: "OUTCOME_TRAFFIC",
      dailyBudgetCents: 500,
      startsAt: new Date("2026-10-12T08:00:00.000Z"),
      endsAt: over.endsAt ?? new Date("2026-10-14T08:00:00.000Z"),
      targeting: { countries: ["SA"], ageMin: 25, ageMax: 45 },
      platforms: ["facebook"],
      caption: "Our autumn offer",
      linkUrl: "https://example.com/offer",
      status: over.status ?? "PAUSED",
      metaCampaignId: over.withIds === false ? null : "c1",
      metaAdSetId: over.withIds === false ? null : "s1",
      metaAdId: over.withIds === false ? null : "a1",
    },
  });
  return { user, campaign };
}

function metaStub(refuseOn?: string) {
  const calls: { id: string; status: string | null }[] = [];
  const fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const id = url.split("/").pop()!;
    const status = new URLSearchParams(String(init?.body ?? "")).get("status");
    calls.push({ id, status });
    if (refuseOn && id === refuseOn && status === "ACTIVE") {
      return new Response(JSON.stringify({ error: { message: "Payment method needed", code: 2 } }), {
        status: 400,
        headers: { "content-type": "application/json" },
      });
    }
    return new Response(JSON.stringify({ success: true }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  });
  return { fetcher, calls };
}

beforeEach(wipe);
afterAll(async () => {
  await wipe();
  await prisma.$disconnect();
});

describe("reviewCampaign", () => {
  it("counts each calendar day of the run once, in UTC", () => {
    const days = runDays(new Date("2026-10-12T23:00:00Z"), new Date("2026-10-14T01:00:00Z"));
    expect(days).toBe(3);
  });

  it("gives the most the campaign can spend: daily budget times days", () => {
    const review = reviewCampaign({
      name: "x",
      objective: "OUTCOME_TRAFFIC",
      dailyBudgetCents: 500,
      startsAt: new Date("2026-10-12T08:00:00Z"),
      endsAt: new Date("2026-10-14T08:00:00Z"),
      platforms: ["facebook"],
      targeting: { countries: ["SA"], ageMin: 25, ageMax: 45 },
    });
    expect(review.days).toBe(3);
    expect(review.maxTotalCents).toBe(1500);
    expect(review.lines.join("\n")).toContain("up to 1500 in total");
  });
});

describe("activateAdCampaign", () => {
  it("switches on the campaign, its ad set and its ad when the confirmed ceiling matches", async () => {
    const { user, campaign } = await seed();
    const meta = metaStub();

    const result = await activateAdCampaign(user.id, campaign.id, 1500, meta.fetcher, NOW);

    expect(result).toEqual({ ok: true, status: "ACTIVE" });
    expect(meta.calls).toEqual([
      { id: "c1", status: "ACTIVE" },
      { id: "s1", status: "ACTIVE" },
      { id: "a1", status: "ACTIVE" },
    ]);
    const after = await prisma.adCampaign.findUniqueOrThrow({ where: { id: campaign.id } });
    expect(after.status).toBe("ACTIVE");
  });

  it("refuses when the campaign changed since it was reviewed, and switches nothing on", async () => {
    const { user, campaign } = await seed();
    const meta = metaStub();

    const result = await activateAdCampaign(user.id, campaign.id, 999, meta.fetcher, NOW);

    expect(result.ok).toBe(false);
    expect(meta.fetcher).not.toHaveBeenCalled();
    expect((await prisma.adCampaign.findUniqueOrThrow({ where: { id: campaign.id } })).status).toBe("PAUSED");
  });

  it("refuses a campaign that already ended", async () => {
    const { user, campaign } = await seed({ endsAt: new Date("2026-10-10T08:00:00.000Z") });
    const meta = metaStub();

    const result = await activateAdCampaign(user.id, campaign.id, 0, meta.fetcher, NOW);

    expect(result).toMatchObject({ ok: false });
    expect(meta.fetcher).not.toHaveBeenCalled();
  });

  it("refuses a campaign that is not paused", async () => {
    const { user, campaign } = await seed({ status: "ACTIVE" });
    const meta = metaStub();

    const result = await activateAdCampaign(user.id, campaign.id, 1500, meta.fetcher, NOW);

    expect(result).toMatchObject({ ok: false });
    expect(meta.fetcher).not.toHaveBeenCalled();
  });

  it("pauses everything again when Meta refuses one part-way, and records why", async () => {
    const { user, campaign } = await seed();
    const meta = metaStub("s1");

    const result = await activateAdCampaign(user.id, campaign.id, 1500, meta.fetcher, NOW);

    expect(result.ok).toBe(false);
    const after = await prisma.adCampaign.findUniqueOrThrow({ where: { id: campaign.id } });
    expect(after.status).toBe("FAILED");
    expect(after.error).toContain("Meta refused the adset (2): Payment method needed");
    expect(after.error).toContain("Everything was paused again.");
    // The campaign was switched on, then switched back off after the refusal. The ad
    // set was refused, so it was never on and nothing is sent to pause it.
    expect(meta.calls).toEqual([
      { id: "c1", status: "ACTIVE" },
      { id: "s1", status: "ACTIVE" },
      { id: "c1", status: "PAUSED" },
    ]);
    expect(after.error).not.toContain(TOKEN);
  });

  it("refuses when a Meta object was never created", async () => {
    const { user, campaign } = await seed({ withIds: false });
    const meta = metaStub();

    const result = await activateAdCampaign(user.id, campaign.id, 1500, meta.fetcher, NOW);

    expect(result).toMatchObject({ ok: false });
    expect(meta.fetcher).not.toHaveBeenCalled();
  });

  it("refuses without a connected Facebook account", async () => {
    const { user, campaign } = await seed({ connected: false });
    const meta = metaStub();

    const result = await activateAdCampaign(user.id, campaign.id, 1500, meta.fetcher, NOW);

    expect(result).toMatchObject({ ok: false });
    expect(meta.fetcher).not.toHaveBeenCalled();
  });
});
