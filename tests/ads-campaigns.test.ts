import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { prisma } from "@/lib/db";
import { sealCredential } from "@/lib/secrets";
import { validateAdCampaign } from "@/lib/ads/validate";
import { createAdCampaign } from "@/server/ads/campaigns";

/**
 * The ads campaign's first step: what is refused before Meta is called, what is
 * sent to Meta, and that every object is created PAUSED. Meta is a stub here, so
 * nothing is spent, and the Graph API is never reached.
 */

const NOW = new Date("2026-10-11T08:00:00.000Z");
const START = "2026-10-12T08:00:00.000Z";
const END = "2026-10-19T08:00:00.000Z";
const PLAN_ID = "test-plan-ads";
const TOKEN = "EAA-test-user-token-never-logged";

function valid(over: Record<string, unknown> = {}) {
  return {
    adAccountId: "act_1234567890",
    pageId: "10987654321",
    name: "Autumn launch",
    objective: "OUTCOME_TRAFFIC",
    dailyBudgetCents: 500,
    startsAt: START,
    endsAt: END,
    targeting: { countries: ["SA", "AE"], ageMin: 25, ageMax: 45 },
    platforms: ["facebook", "instagram"],
    caption: "Our autumn offer is live",
    linkUrl: "https://example.com/offer",
    mediaUrl: "https://marketplace-production-3f79.up.railway.app/api/media/abc.jpg",
    ...over,
  };
}

async function wipe() {
  await prisma.adCampaign.deleteMany({});
  await prisma.connectedAccount.deleteMany({});
  await prisma.user.deleteMany({});
  await prisma.plan.deleteMany({});
}

async function seedUser(connected = true, expiresAt: Date | null = null) {
  await prisma.plan.create({
    data: { id: PLAN_ID, name: "T", monthlyRuns: 1, storageBytes: BigInt(1), monthlyCredits: 0 },
  });
  const user = await prisma.user.create({
    data: { email: "ads@example.test", name: "A", passwordHash: "x", initials: "A", planId: PLAN_ID },
  });
  if (connected) {
    await prisma.connectedAccount.create({
      data: {
        userId: user.id,
        credentialType: "facebookGraphApi",
        displayName: "Facebook & Instagram",
        initials: "FB",
        accountRef: "Nora · Acme",
        status: "ACTIVE",
        secretJson: sealCredential({ accessToken: TOKEN }),
        expiresAt,
      },
    });
  }
  return user;
}

/** A Meta stand-in: answers each create with an id, or refuses the named step. */
function metaStub(refuse?: "campaigns" | "adsets" | "ads") {
  const calls: { url: string; body: URLSearchParams }[] = [];
  let n = 0;
  const fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const body = new URLSearchParams(String(init?.body ?? ""));
    calls.push({ url, body });
    const step = url.split("/").pop()!;
    if (refuse && url.includes(`/${refuse}`)) {
      return new Response(
        JSON.stringify({ error: { message: "Invalid parameter", code: 100 } }),
        { status: 400, headers: { "content-type": "application/json" } },
      );
    }
    n += 1;
    return new Response(JSON.stringify({ id: `${step}-${n}` }), {
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

describe("validateAdCampaign", () => {
  it("accepts a complete campaign and returns it typed", () => {
    const result = validateAdCampaign(valid(), NOW);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.dailyBudgetCents).toBe(500);
      expect(result.value.startsAt.toISOString()).toBe(START);
    }
  });

  it("reports every problem at once, not one at a time", () => {
    const result = validateAdCampaign(
      valid({
        adAccountId: "123",
        dailyBudgetCents: 0,
        endsAt: "2026-10-01T00:00:00.000Z",
        targeting: { countries: ["Saudi"], ageMin: 12, ageMax: 70 },
        linkUrl: "http://insecure.example",
        mediaUrl: "https://example.com/clip.gif",
      }),
      NOW,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors.length).toBeGreaterThanOrEqual(6);
  });

  it("refuses a start less than a minute away, and an end before the start", () => {
    expect(validateAdCampaign(valid({ startsAt: "2026-10-11T08:00:30.000Z" }), NOW).ok).toBe(false);
    expect(validateAdCampaign(valid({ endsAt: START }), NOW).ok).toBe(false);
  });

  it("refuses a campaign longer than a year", () => {
    const result = validateAdCampaign(valid({ endsAt: "2028-01-01T00:00:00.000Z" }), NOW);
    expect(result.ok).toBe(false);
  });

  it("requires a page, a real ad account id and at least one platform", () => {
    expect(validateAdCampaign(valid({ pageId: "" }), NOW).ok).toBe(false);
    expect(validateAdCampaign(valid({ adAccountId: "act_x" }), NOW).ok).toBe(false);
    expect(validateAdCampaign(valid({ platforms: [] }), NOW).ok).toBe(false);
    expect(validateAdCampaign(valid({ platforms: ["tiktok"] }), NOW).ok).toBe(false);
  });

  it("allows a text-only ad but checks any image it is given", () => {
    expect(validateAdCampaign(valid({ mediaUrl: null }), NOW).ok).toBe(true);
    expect(validateAdCampaign(valid({ mediaUrl: "https://example.com/a.webp" }), NOW).ok).toBe(false);
    expect(validateAdCampaign(valid({ mediaUrl: "http://example.com/a.jpg" }), NOW).ok).toBe(false);
  });

  it("uses cents, with one unit of the currency as the floor", () => {
    expect(validateAdCampaign(valid({ dailyBudgetCents: 99 }), NOW).ok).toBe(false);
    expect(validateAdCampaign(valid({ dailyBudgetCents: 100 }), NOW).ok).toBe(true);
    expect(validateAdCampaign(valid({ dailyBudgetCents: 12.5 }), NOW).ok).toBe(false);
  });
});

describe("createAdCampaign", () => {
  it("creates the campaign, ad set, creative and ad, all PAUSED, and records their ids", async () => {
    const user = await seedUser();
    const meta = metaStub();

    const result = await createAdCampaign(user.id, valid(), meta.fetcher, NOW);

    expect(result).toMatchObject({
      ok: true,
      campaignId: expect.any(String),
      status: "PAUSED",
      review: { days: 8, maxTotalCents: 4000 },
    });
    expect(meta.calls.map((c) => c.url.split("/").pop())).toEqual([
      "campaigns",
      "adsets",
      "adcreatives",
      "ads",
    ]);
    // Nothing reaches Meta switched on.
    for (const call of meta.calls) {
      if (call.body.has("status")) expect(call.body.get("status")).toBe("PAUSED");
    }
    const adSet = meta.calls[1].body;
    expect(adSet.get("daily_budget")).toBe("500");
    expect(adSet.get("optimization_goal")).toBe("LINK_CLICKS");
    expect(JSON.parse(adSet.get("targeting")!).geo_locations.countries).toEqual(["SA", "AE"]);
    expect(JSON.parse(adSet.get("promoted_object")!)).toEqual({ page_id: "10987654321" });
    // The token goes to Meta in the body, and only there.
    expect(meta.calls.every((c) => c.body.get("access_token") === TOKEN)).toBe(true);

    const row = await prisma.adCampaign.findFirstOrThrow({ where: { userId: user.id } });
    expect(row.status).toBe("PAUSED");
    expect(row.metaCampaignId).toBe("campaigns-1");
    expect(row.metaAdSetId).toBe("adsets-2");
    expect(row.metaAdId).toBe("ads-4");
    expect(row.error).toBeNull();
  });

  it("stops at the step Meta refuses, keeps what was made, and says why", async () => {
    const user = await seedUser();
    const meta = metaStub("adsets");

    const result = await createAdCampaign(user.id, valid(), meta.fetcher, NOW);

    expect(result.ok).toBe(false);
    const row = await prisma.adCampaign.findFirstOrThrow({ where: { userId: user.id } });
    expect(row.status).toBe("FAILED");
    expect(row.metaCampaignId).toBe("campaigns-1");
    expect(row.metaAdSetId).toBeNull();
    expect(row.error).toContain("Meta refused the adset (100): Invalid parameter");
    expect(row.error).not.toContain(TOKEN);
    expect(meta.calls).toHaveLength(2);
  });

  it("refuses without a connected Facebook account and creates nothing", async () => {
    const user = await seedUser(false);
    const meta = metaStub();

    const result = await createAdCampaign(user.id, valid(), meta.fetcher, NOW);

    expect(result.ok).toBe(false);
    expect(meta.fetcher).not.toHaveBeenCalled();
    expect(await prisma.adCampaign.count()).toBe(0);
  });

  it("refuses an expired Facebook connection before calling Meta", async () => {
    const user = await seedUser(true, new Date("2026-10-01T00:00:00.000Z"));
    const meta = metaStub();

    const result = await createAdCampaign(user.id, valid(), meta.fetcher, NOW);

    expect(result).toMatchObject({ ok: false });
    expect(meta.fetcher).not.toHaveBeenCalled();
  });

  it("returns the refusal list without touching the database when the input is wrong", async () => {
    const user = await seedUser();
    const meta = metaStub();

    const result = await createAdCampaign(user.id, valid({ dailyBudgetCents: 1 }), meta.fetcher, NOW);

    expect(result.ok).toBe(false);
    expect(meta.fetcher).not.toHaveBeenCalled();
    expect(await prisma.adCampaign.count()).toBe(0);
  });
});
