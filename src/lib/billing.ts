import "server-only";
import Stripe from "stripe";
import { prisma } from "./db";
import { env } from "./env";

/**
 * Paid plans, through Stripe. Stripe takes the card (Visa, Mastercard, Apple Pay when
 * enabled there) and tells us what happened by webhook; the plan a person is on is
 * changed only from those events, never from the browser coming back from Checkout.
 *
 * A plan change is written to User.planId, which every limit already reads
 * (run-engine, knowledge limits, storage), so an upgrade takes effect at once and a
 * cancellation or failed renewal brings the person back to Free.
 */

export const PAID_PLAN_IDS = ["pro", "team"] as const;
export type PaidPlanId = (typeof PAID_PLAN_IDS)[number];
export const FREE_PLAN_ID = "free";

export function billingConfigured(): boolean {
  return Boolean(env.stripe.secretKey && env.stripe.priceIds.pro && env.stripe.priceIds.team);
}

let client: Stripe | null = null;
export function stripeClient(): Stripe {
  if (!env.stripe.secretKey) throw new Error("STRIPE_SECRET_KEY is not set.");
  client ??= new Stripe(env.stripe.secretKey);
  return client;
}

/**
 * Checks a webhook's signature and returns the event. Verification makes no request to
 * Stripe, so it works without the secret key; the placeholder only satisfies the client.
 */
export function verifyStripeEvent(body: string, signature: string): Stripe.Event {
  return new Stripe(env.stripe.secretKey || "sk_not_configured").webhooks.constructEvent(
    body,
    signature,
    env.stripe.webhookSecret,
  );
}

function priceIdFor(planId: PaidPlanId): string {
  return env.stripe.priceIds[planId];
}

/** Which paid plan a Stripe price belongs to, or null for a price we do not sell. */
export function planForPrice(priceId: string | undefined): PaidPlanId | null {
  if (!priceId) return null;
  return PAID_PLAN_IDS.find((planId) => priceIdFor(planId) === priceId) ?? null;
}

export async function checkoutUrl(
  user: { id: string; email: string; stripeCustomerId: string | null },
  planId: PaidPlanId,
  urls: { success: string; cancel: string },
): Promise<string> {
  const session = await stripeClient().checkout.sessions.create({
    mode: "subscription",
    line_items: [{ price: priceIdFor(planId), quantity: 1 }],
    // An existing customer keeps one payment history; a new one is created at checkout.
    ...(user.stripeCustomerId
      ? { customer: user.stripeCustomerId }
      : { customer_email: user.email }),
    client_reference_id: user.id,
    metadata: { userId: user.id, planId },
    subscription_data: { metadata: { userId: user.id, planId } },
    allow_promotion_codes: true,
    success_url: urls.success,
    cancel_url: urls.cancel,
  });
  if (!session.url) throw new Error("Stripe did not return a Checkout address.");
  return session.url;
}

export async function portalUrl(customerId: string, returnUrl: string): Promise<string> {
  const session = await stripeClient().billingPortal.sessions.create({
    customer: customerId,
    return_url: returnUrl,
  });
  return session.url;
}

async function moveToFree(where: { id: string } | { stripeSubscriptionId: string }) {
  await prisma.user.updateMany({
    where,
    data: { planId: FREE_PLAN_ID, renewsAt: null, stripeSubscriptionId: null },
  });
}

/**
 * Applies one Stripe event to the platform. Safe to receive twice: every write sets a
 * value rather than adding to one. Events we do not use are ignored.
 */
export async function handleStripeEvent(event: Stripe.Event): Promise<void> {
  switch (event.type) {
    case "checkout.session.completed": {
      const session = event.data.object;
      const userId = session.client_reference_id ?? session.metadata?.userId;
      if (!userId || session.mode !== "subscription") return;
      await prisma.user.updateMany({
        where: { id: userId },
        data: {
          stripeCustomerId: typeof session.customer === "string" ? session.customer : null,
          stripeSubscriptionId:
            typeof session.subscription === "string" ? session.subscription : null,
        },
      });
      return;
    }

    case "customer.subscription.created":
    case "customer.subscription.updated": {
      const subscription = event.data.object;
      const item = subscription.items.data[0];
      const planId = planForPrice(item?.price.id);
      const active = subscription.status === "active" || subscription.status === "trialing";

      if (!active || !planId) {
        // Past due, cancelled, unpaid or a price we do not sell: the Free plan.
        if (!active) await moveToFree({ stripeSubscriptionId: subscription.id });
        return;
      }
      const userId = subscription.metadata?.userId;
      const where = userId ? { id: userId } : { stripeSubscriptionId: subscription.id };
      await prisma.user.updateMany({
        where,
        data: {
          planId,
          stripeSubscriptionId: subscription.id,
          stripeCustomerId:
            typeof subscription.customer === "string" ? subscription.customer : undefined,
          renewsAt: item ? new Date(item.current_period_end * 1000) : null,
        },
      });
      return;
    }

    case "customer.subscription.deleted":
      await moveToFree({ stripeSubscriptionId: event.data.object.id });
      return;

    default:
      return;
  }
}
