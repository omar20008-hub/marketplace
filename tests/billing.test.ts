import { beforeAll, describe, expect, it, vi } from "vitest";
import Stripe from "stripe";

/**
 * Stripe's events, applied to the plan a person is on. No network: the events are
 * built here, and the webhook's signature check is exercised with Stripe's own test
 * header helper.
 */

const { prisma } = await import("@/lib/db");
const { env } = await import("@/lib/env");
const { handleStripeEvent, planForPrice } = await import("@/lib/billing");
const { POST } = await import("@/app/api/billing/webhook/route");

const PRICES = { pro: "price_test_pro", team: "price_test_team" };
const WEBHOOK_SECRET = "whsec_test_billing_secret_0123456789";

(env.stripe as { priceIds: typeof PRICES }).priceIds = PRICES;
(env.stripe as { webhookSecret: string }).webhookSecret = WEBHOOK_SECRET;

beforeAll(async () => {
  for (const plan of [
    { id: "free", name: "Free", priceMonthly: 0 },
    { id: "pro", name: "Pro", priceMonthly: 20 },
    { id: "team", name: "Team", priceMonthly: 100 },
  ]) {
    await prisma.plan.upsert({
      where: { id: plan.id },
      create: { ...plan, monthlyRuns: 1, storageBytes: BigInt(1), monthlyCredits: 0 },
      update: {},
    });
  }
});

let counter = 0;
async function person(planId = "free") {
  counter += 1;
  return prisma.user.create({
    data: {
      email: `billing-${counter}-${Date.now()}@example.test`,
      name: "Billing",
      passwordHash: "x",
      initials: "BI",
      planId,
    },
  });
}

function subscription(overrides: Record<string, unknown> = {}) {
  const unique = Math.random().toString(36).slice(2, 10);
  return {
    id: `sub_${unique}`,
    object: "subscription",
    customer: `cus_${unique}`,
    status: "active",
    metadata: {},
    items: {
      data: [{ price: { id: PRICES.team }, current_period_end: 1_800_000_000 }],
    },
    ...overrides,
  };
}

function event(type: string, object: unknown): Stripe.Event {
  return { id: `evt_${Math.random().toString(36).slice(2)}`, type, data: { object } } as unknown as Stripe.Event;
}

describe("billing: plan from Stripe's events", () => {
  it("knows which paid plan a price belongs to, and nothing else", () => {
    expect(planForPrice(PRICES.pro)).toBe("pro");
    expect(planForPrice(PRICES.team)).toBe("team");
    expect(planForPrice("price_somebody_else")).toBeNull();
    expect(planForPrice(undefined)).toBeNull();
  });

  it("moves the person to the paid plan with its renewal date", async () => {
    const user = await person();
    const sub = subscription({ metadata: { userId: user.id } });
    await handleStripeEvent(event("customer.subscription.created", sub));

    const after = await prisma.user.findUniqueOrThrow({ where: { id: user.id } });
    expect(after.planId).toBe("team");
    expect(after.stripeSubscriptionId).toBe(sub.id);
    expect(after.stripeCustomerId).toBe(sub.customer);
    expect(after.renewsAt?.toISOString()).toBe(new Date(1_800_000_000 * 1000).toISOString());
  });

  it("moves the person back to Free when the subscription is cancelled", async () => {
    const user = await person("team");
    const sub = subscription();
    await prisma.user.update({
      where: { id: user.id },
      data: { stripeSubscriptionId: sub.id, stripeCustomerId: sub.customer },
    });

    await handleStripeEvent(event("customer.subscription.deleted", sub));

    const after = await prisma.user.findUniqueOrThrow({ where: { id: user.id } });
    expect(after.planId).toBe("free");
    expect(after.stripeSubscriptionId).toBeNull();
    expect(after.renewsAt).toBeNull();
  });

  it("falls back to Free when a renewal fails, and stays there on a repeat", async () => {
    const user = await person("pro");
    await prisma.user.update({ where: { id: user.id }, data: { stripeSubscriptionId: "sub_due_1" } });
    const unpaid = event("customer.subscription.updated", subscription({ id: "sub_due_1", status: "past_due" }));

    await handleStripeEvent(unpaid);
    await handleStripeEvent(unpaid);

    const after = await prisma.user.findUniqueOrThrow({ where: { id: user.id } });
    expect(after.planId).toBe("free");
  });

  it("ignores a price we do not sell, leaving the plan as it is", async () => {
    const user = await person("pro");
    await handleStripeEvent(
      event(
        "customer.subscription.updated",
        subscription({
          metadata: { userId: user.id },
          items: { data: [{ price: { id: "price_unknown" }, current_period_end: 1 }] },
        }),
      ),
    );
    expect((await prisma.user.findUniqueOrThrow({ where: { id: user.id } })).planId).toBe("pro");
  });

  it("records the Stripe customer and subscription from a completed checkout", async () => {
    const user = await person();
    const sub = subscription();
    await handleStripeEvent(
      event("checkout.session.completed", {
        mode: "subscription",
        client_reference_id: user.id,
        customer: sub.customer,
        subscription: sub.id,
        metadata: {},
      }),
    );
    const after = await prisma.user.findUniqueOrThrow({ where: { id: user.id } });
    expect(after.stripeCustomerId).toBe(sub.customer);
    expect(after.stripeSubscriptionId).toBe(sub.id);
  });

  it("refuses a webhook without Stripe's signature, and one signed with another secret", async () => {
    const payload = JSON.stringify(event("customer.subscription.deleted", subscription()));
    const unsigned = await POST(new Request("https://x.test/api/billing/webhook", { method: "POST", body: payload }));
    expect(unsigned.status).toBe(400);

    const header = Stripe.webhooks.generateTestHeaderString({ payload, secret: "whsec_someone_else_0123456789" });
    const forged = await POST(
      new Request("https://x.test/api/billing/webhook", {
        method: "POST",
        body: payload,
        headers: { "stripe-signature": header },
      }),
    );
    expect(forged.status).toBe(400);
  });

  it("logs why a webhook was refused, without the secret", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const payload = JSON.stringify(event("customer.subscription.deleted", subscription()));
    const header = Stripe.webhooks.generateTestHeaderString({ payload, secret: "whsec_someone_else_0123456789" });

    await POST(
      new Request("https://x.test/api/billing/webhook", {
        method: "POST",
        body: payload,
        headers: { "stripe-signature": header },
      }),
    );

    const logged = warn.mock.calls.flat().join(" ");
    expect(logged).toMatch(/signature does not match/);
    expect(logged).toMatch(/secret looks like a signing secret: true/);
    expect(logged).not.toContain(WEBHOOK_SECRET);
    warn.mockRestore();
  });

  it("applies a properly signed event", async () => {
    const user = await person();
    const payload = JSON.stringify(
      event("customer.subscription.created", subscription({ metadata: { userId: user.id } })),
    );
    const header = Stripe.webhooks.generateTestHeaderString({ payload, secret: WEBHOOK_SECRET });

    const response = await POST(
      new Request("https://x.test/api/billing/webhook", {
        method: "POST",
        body: payload,
        headers: { "stripe-signature": header },
      }),
    );

    expect(response.status).toBe(200);
    expect((await prisma.user.findUniqueOrThrow({ where: { id: user.id } })).planId).toBe("team");
  });
});
