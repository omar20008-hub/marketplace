import { NextResponse } from "next/server";
import type Stripe from "stripe";
import { env } from "@/lib/env";
import { handleStripeEvent, verifyStripeEvent } from "@/lib/billing";

/**
 * Where Stripe reports payments and subscription changes. A request that does not
 * carry a valid signature for the webhook secret is refused. A handler failure answers
 * 500 so Stripe sends the event again.
 */
export async function POST(request: Request) {
  if (!env.stripe.webhookSecret) {
    return NextResponse.json({ error: "not configured" }, { status: 503 });
  }
  const signature = request.headers.get("stripe-signature");
  if (!signature) return NextResponse.json({ error: "no signature" }, { status: 400 });

  const body = await request.text();
  let event: Stripe.Event;
  try {
    event = verifyStripeEvent(body, signature);
  } catch {
    return NextResponse.json({ error: "bad signature" }, { status: 400 });
  }

  try {
    await handleStripeEvent(event);
  } catch (error) {
    console.error("Stripe event failed", event.type, error instanceof Error ? error.message : "unknown");
    return NextResponse.json({ error: "handler failed" }, { status: 500 });
  }
  return NextResponse.json({ received: true });
}
