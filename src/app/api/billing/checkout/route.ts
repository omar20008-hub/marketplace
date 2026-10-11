import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { requireUser } from "@/lib/auth";
import { appUrl } from "@/lib/public-origin";
import { billingConfigured, checkoutUrl, PAID_PLAN_IDS, type PaidPlanId } from "@/lib/billing";

/**
 * Starts a Stripe Checkout for a paid plan. A plain link from the pricing page
 * (GET, so it works without a form), and the person is sent straight to Stripe.
 */
export async function GET(request: Request) {
  const user = await requireUser();
  const requested = new URL(request.url).searchParams.get("plan") ?? "";
  const planId = PAID_PLAN_IDS.find((id) => id === requested) as PaidPlanId | undefined;
  const back = (params: Record<string, string>) =>
    NextResponse.redirect(appUrl("/pricing", params, request), 303);

  if (!planId) return back({ billing: "unknown_plan" });
  if (!billingConfigured()) {
    console.error("Billing is not configured; set the STRIPE_* settings.");
    return back({ billing: "not_configured" });
  }

  const person = await prisma.user.findUniqueOrThrow({ where: { id: user.id } });
  try {
    const url = await checkoutUrl(person, planId, {
      success: appUrl("/pricing", { billing: "done" }, request),
      cancel: appUrl("/pricing", { billing: "cancelled" }, request),
    });
    return NextResponse.redirect(url, 303);
  } catch (error) {
    console.error("Checkout could not be started", error instanceof Error ? error.message : "unknown");
    return back({ billing: "failed" });
  }
}
