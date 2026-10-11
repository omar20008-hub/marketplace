import { prisma } from "@/lib/db";
import { requireUser } from "@/lib/auth";
import { ButtonAnchor, Card, FootNote, PageTitle, SectionLabel } from "@/components/ds";
import { billingConfigured, FREE_PLAN_ID, PAID_PLAN_IDS } from "@/lib/billing";
import { formatBytes } from "@/lib/readiness";

export const metadata = { title: "Plans · Builder" };

const NOTICES: Record<string, string> = {
  done: "Thank you. Your plan updates as soon as Stripe confirms the payment.",
  cancelled: "Checkout was cancelled. Nothing was charged.",
  not_configured: "Payments are not set up yet.",
  failed: "The payment page could not be opened. Try again in a moment.",
  unknown_plan: "That plan does not exist.",
};

export default async function PricingPage({
  searchParams,
}: {
  searchParams: Promise<{ billing?: string }>;
}) {
  const { billing } = await searchParams;
  const user = await requireUser();
  const [plans, person] = await Promise.all([
    prisma.plan.findMany({ orderBy: { priceMonthly: "asc" } }),
    prisma.user.findUniqueOrThrow({ where: { id: user.id }, select: { planId: true, renewsAt: true, stripeCustomerId: true } }),
  ]);
  const configured = billingConfigured();

  return (
    <div className="mx-auto flex max-w-[960px] flex-col gap-6 px-5 py-8">
      <PageTitle title="Plans" meta="Pay by card or Apple Pay. Cancel from the billing page at any time." />

      {billing && NOTICES[billing] ? (
        <p role="status" className="rounded-card bg-fill px-4 py-3 text-[13px] text-ink-2">
          {NOTICES[billing]}
        </p>
      ) : null}

      <div className="grid gap-4 md:grid-cols-3">
        {plans.map((plan) => {
          const current = plan.id === person.planId;
          const paid = (PAID_PLAN_IDS as readonly string[]).includes(plan.id);
          return (
            <Card key={plan.id} className="flex flex-col gap-4 p-5">
              <div>
                <div className="text-sm font-medium">{plan.name}</div>
                <div className="mt-1 text-2xl font-semibold">
                  {plan.priceMonthly === 0 ? "Free" : `$${plan.priceMonthly}`}
                  {plan.priceMonthly ? <span className="text-sm font-normal text-ink-3"> / month</span> : null}
                </div>
              </div>
              <ul className="flex flex-col gap-1.5 text-[13px] text-ink-2">
                <li>{plan.monthlyRuns.toLocaleString()} runs a month</li>
                <li>{formatBytes(Number(plan.storageBytes))} of stored files</li>
                <li>{plan.knowledgeSources} Google Drive folder{plan.knowledgeSources === 1 ? "" : "s"}</li>
                <li>Up to {plan.knowledgeFiles.toLocaleString()} indexed files</li>
              </ul>
              <div className="mt-auto">
                {current ? (
                  <p className="text-[13px] text-ink-3">Your current plan</p>
                ) : paid && configured ? (
                  <ButtonAnchor href={`/api/billing/checkout?plan=${plan.id}`} size="sm">
                    Choose {plan.name}
                  </ButtonAnchor>
                ) : plan.id === FREE_PLAN_ID ? (
                  <p className="text-[13px] text-ink-3">Included</p>
                ) : (
                  <p className="text-[13px] text-ink-3">Not available yet</p>
                )}
              </div>
            </Card>
          );
        })}
      </div>

      {person.stripeCustomerId ? (
        <section className="flex flex-col gap-2">
          <SectionLabel>Billing</SectionLabel>
          <div>
            <ButtonAnchor href="/api/billing/portal" tone="secondary" size="sm">
              Manage or cancel subscription
            </ButtonAnchor>
          </div>
          {person.renewsAt ? (
            <FootNote>Renews on {person.renewsAt.toLocaleDateString("en-GB")}.</FootNote>
          ) : null}
        </section>
      ) : null}
    </div>
  );
}
