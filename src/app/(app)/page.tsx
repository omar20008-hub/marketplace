import Link from "next/link";
import { ChevronDown, Sparkles } from "lucide-react";
import { prisma } from "@/lib/db";
import { requireUser } from "@/lib/auth";
import { Badge, ButtonLink } from "@/components/ds";
import { ProductGlyph } from "@/components/app/product-glyph";
import { Composer } from "@/components/app/composer";
import { readinessFor } from "@/lib/readiness";
import { relativeDays } from "@/lib/readiness";

export const metadata = { title: "New task · Builder" };

const SUGGESTIONS = [
  "Summarise this week's sales and send it to Teams",
  "Turn this spreadsheet into an expense report",
  "Draft 10 captions from our product page",
];

export default async function HomePage() {
  const user = await requireUser();

  const [installations, accounts, runCounts] = await Promise.all([
    prisma.installation.findMany({
      where: { userId: user.id, status: { in: ["ACTIVE", "PARTIAL"] } },
      include: { product: { include: { requirements: true } } },
      orderBy: { lastRunAt: "desc" },
    }),
    prisma.connectedAccount.findMany({ where: { userId: user.id } }),
    prisma.run.groupBy({
      by: ["installationId"],
      where: { userId: user.id },
      _count: { _all: true },
    }),
  ]);

  const runsByInstallation = new Map(
    runCounts.map((row) => [row.installationId, row._count._all]),
  );

  const cards = installations.map((installation) => {
    const readiness = readinessFor({
      productStatus: installation.product.status,
      requirements: installation.product.requirements,
      accounts,
      installed: true,
      installationStatus: installation.status,
    });
    return { installation, readiness };
  });

  const ready = cards.filter((card) => card.readiness.tone === "ready");

  return (
    <div className="flex min-h-full flex-col">
      <header className="flex h-14 items-center justify-between px-4 md:pr-4 md:pl-5">
        <div className="flex h-9 items-center gap-1.5 rounded-row px-2.5 text-base font-medium">
          Builder <span className="font-normal text-ink-3">Auto</span>
          <ChevronDown size={16} strokeWidth={1.8} className="text-ink-3" />
        </div>
        <ButtonLink href="/workspace" tone="upgrade" size="sm" className="h-[34px]">
          <Sparkles size={15} strokeWidth={1.8} />
          Upgrade to Team
        </ButtonLink>
      </header>

      <div className="flex flex-1 flex-col items-center px-5 pt-12 pb-16 md:px-10 md:pt-24">
        <h1 className="text-center text-[30px] leading-tight font-medium tracking-[-0.02em]">
          What do you want to get done?
        </h1>
        <p className="mt-2.5 max-w-[520px] text-center text-[15px] text-ink-2">
          Describe the task. We match it to an agent or workflow you already own,
          or suggest one from the Marketplace.
        </p>

        <Composer
          className="mt-8"
          suggestions={SUGGESTIONS}
          products={installations.map((installation) => ({
            id: installation.id,
            title: installation.product.title,
          }))}
        />

        <p className="mt-2.5 text-xs text-ink-3">
          Routine runs are included in your plan. Choosing a specific model spends
          credits.
        </p>

        <div className="mt-7 w-full max-w-[720px]">
          <div className="flex items-baseline justify-between px-1 pb-3">
            <span className="text-[13px] font-medium text-ink-2">
              In your workspace · ready to run{" "}
              <span className="font-normal text-ink-3">{ready.length}</span>
            </span>
            <Link href="/workspace" className="text-[13px]">
              See all
            </Link>
          </div>

          <div className="grid grid-cols-1 gap-2.5 sm:grid-cols-2 lg:grid-cols-3">
            {cards.slice(0, 3).map(({ installation, readiness }) => (
              <Link
                key={installation.id}
                href={`/marketplace/${installation.product.slug}`}
                className="flex flex-col gap-2.5 rounded-card border border-selected p-3.5 hover:border-line"
              >
                <div className="flex items-center justify-between">
                  <ProductGlyph
                    category={installation.product.category}
                    kind={installation.product.kind}
                  />
                  <Badge tone={readiness.tone}>
                    {readiness.tone === "partial"
                      ? `${readiness.missing.length} setup`
                      : readiness.label}
                  </Badge>
                </div>
                <div>
                  <div className="text-sm font-medium">
                    {installation.product.title}
                  </div>
                  <div className="mt-0.5 text-xs text-ink-3">
                    {readiness.tone === "partial"
                      ? `Connect ${readiness.missing[0]} to run`
                      : `${installation.product.kind === "AGENT" ? "Agent" : "Workflow"} · ${
                          (runsByInstallation.get(installation.id) ?? 0) > 1
                            ? `${runsByInstallation.get(installation.id)} runs`
                            : `last run ${relativeDays(installation.lastRunAt)}`
                        }`}
                  </div>
                </div>
              </Link>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
