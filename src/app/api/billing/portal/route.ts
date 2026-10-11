import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { requireUser } from "@/lib/auth";
import { appUrl } from "@/lib/public-origin";
import { billingConfigured, portalUrl } from "@/lib/billing";

/** Stripe's own page for changing or cancelling a subscription. */
export async function GET(request: Request) {
  const user = await requireUser();
  const back = () => NextResponse.redirect(appUrl("/pricing", {}, request), 303);
  if (!billingConfigured()) return back();

  const person = await prisma.user.findUniqueOrThrow({ where: { id: user.id } });
  if (!person.stripeCustomerId) return back();
  try {
    return NextResponse.redirect(
      await portalUrl(person.stripeCustomerId, appUrl("/pricing", {}, request)),
      303,
    );
  } catch (error) {
    console.error("Billing portal could not be opened", error instanceof Error ? error.message : "unknown");
    return back();
  }
}
