import Link from "next/link";
import { ArrowUpRight, Search } from "lucide-react";
import { prisma } from "@/lib/db";
import { requireUser } from "@/lib/auth";
import { Badge } from "@/components/ds";
import { ProductGlyph } from "@/components/app/product-glyph";
import { readinessFor, type Readiness } from "@/lib/readiness";
import { MarketplaceFilters } from "./filters";

export const metadata = { title: "Marketplace · Builder" };

type Search = {
  q?: string;
  type?: string;
  category?: string;
  integration?: string;
  sort?: string;
  ready?: string;
};

const SORTS = ["Featured", "Trending", "New", "Top rated"] as const;

const INTEGRATION_LABELS: Record<string, string> = {
  googleSheetsOAuth2Api: "Sheets",
  googleDriveOAuth2Api: "Drive",
  microsoftTeamsOAuth2Api: "Teams",
  slackApi: "Slack",
  hubspotApi: "HubSpot",
  facebookGraphApi: "Instagram",
};

function compactRuns(runs: number) {
  return runs >= 1000 ? `${(runs / 1000).toFixed(1)}k` : `${runs}`;
}

export default async function MarketplacePage({
  searchParams,
}: {
  searchParams: Promise<Search>;
}) {
  const params = await searchParams;
  const user = await requireUser();

  const monthStart = new Date(
    Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth(), 1),
  );

  const [all, accounts, installations, runsThisMonth] = await Promise.all([
    prisma.product.findMany({
      // Only what a shopper may see. in_review, draft and deleted never appear.
      where: { status: { in: ["PUBLISHED", "RESTRICTED"] } },
      include: { requirements: true, creator: true },
    }),
    prisma.connectedAccount.findMany({ where: { userId: user.id } }),
    prisma.installation.findMany({
      where: { userId: user.id, status: { in: ["ACTIVE", "PARTIAL", "DISABLED"] } },
      select: { productId: true },
    }),
    prisma.run.count({
      where: { userId: user.id, startedAt: { gte: monthStart }, charged: true },
    }),
  ]);

  const installedIds = new Set(installations.map((i) => i.productId));
  const outOfRuns = runsThisMonth >= user.plan.monthlyRuns;

  // Counts come from the table, not from the mock copy. They can be small, but
  // they can never be wrong.
  const typeCounts = {
    AGENT: all.filter((p) => p.kind === "AGENT").length,
    WORKFLOW: all.filter((p) => p.kind === "WORKFLOW").length,
  };
  const categoryCounts = all.reduce<Record<string, number>>((acc, product) => {
    acc[product.category] = (acc[product.category] ?? 0) + 1;
    return acc;
  }, {});
  const integrations = [
    ...new Set(all.flatMap((product) => product.requiredCredentials)),
  ].filter((type) => INTEGRATION_LABELS[type]);

  const query = params.q?.toLowerCase().trim() ?? "";

  const visible = all.filter((product) => {
    if (params.type && product.kind !== params.type) return false;
    if (params.category && product.category !== params.category) return false;
    if (
      params.integration &&
      !product.requiredCredentials.includes(params.integration)
    ) {
      return false;
    }
    if (query) {
      const haystack =
        `${product.title} ${product.summary} ${product.category} ${product.requiredCredentials.join(" ")}`.toLowerCase();
      if (!haystack.includes(query)) return false;
    }
    return true;
  });

  const withReadiness = visible.map((product) => ({
    product,
    readiness: readinessFor({
      productStatus: product.status,
      requirements: product.requirements,
      accounts,
      installed: installedIds.has(product.id),
      overPlanLimit: outOfRuns || (product.usesCredits && user.credits <= 0),
    }),
  }));

  const sort = params.sort ?? "Featured";
  withReadiness.sort((a, b) => {
    switch (sort) {
      case "Trending":
        return Number(b.product.trending) - Number(a.product.trending) ||
          b.product.runsLast30d - a.product.runsLast30d;
      case "New":
        return (
          (b.product.publishedAt?.getTime() ?? 0) -
          (a.product.publishedAt?.getTime() ?? 0)
        );
      case "Top rated":
        return b.product.ratingAvg - a.product.ratingAvg;
      default:
        return (
          Number(b.product.featured) - Number(a.product.featured) ||
          b.product.runsLast30d - a.product.runsLast30d
        );
    }
  });

  const readyOnly = params.ready !== "0";
  const ready = withReadiness.filter((item) => item.readiness.tone === "ready");
  const rest = withReadiness.filter((item) => item.readiness.tone !== "ready");
  const shown = readyOnly ? [...ready, ...rest] : withReadiness;

  return (
    <div className="flex min-h-full flex-col">
      <header className="flex flex-wrap items-center gap-4 px-5 py-3">
        <span className="text-base font-medium">Marketplace</span>
        <form className="flex h-[38px] min-w-0 flex-1 items-center gap-2.5 rounded-full bg-fill px-4 md:max-w-[480px]">
          <Search size={17} strokeWidth={1.8} className="flex-none text-ink-3" />
          <input
            name="q"
            defaultValue={params.q}
            placeholder="Search products, use cases, integrations"
            className="min-w-0 flex-1 bg-transparent text-sm placeholder:text-ink-3 focus:outline-none"
          />
        </form>
        <span className="hidden w-[90px] md:block" />
      </header>

      <div className="flex min-h-0 flex-1 flex-col lg:flex-row">
        <MarketplaceFilters
          typeCounts={typeCounts}
          categoryCounts={categoryCounts}
          integrations={integrations.map((type) => ({
            value: type,
            label: INTEGRATION_LABELS[type],
          }))}
        />

        <div className="flex min-w-0 flex-1 flex-col gap-4 px-5 pt-3 pb-10 lg:pr-7 lg:pl-3">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="flex gap-1 text-sm">
              {SORTS.map((option) => {
                const next = new URLSearchParams(
                  Object.entries(params).filter(([, v]) => v) as [string, string][],
                );
                next.set("sort", option);
                return (
                  <Link
                    key={option}
                    href={`/marketplace?${next}`}
                    className={
                      option === sort
                        ? "rounded-full bg-fill px-3.5 py-[7px] font-medium text-ink"
                        : "rounded-full px-3.5 py-[7px] text-ink-2 hover:text-ink"
                    }
                  >
                    {option}
                  </Link>
                );
              })}
            </div>
            <span className="text-[13px] text-ink-3">
              {shown.length} result{shown.length === 1 ? "" : "s"} · sorted{" "}
              {sort === "Featured" ? "editorially" : sort.toLowerCase()}
            </span>
          </div>

          {ready.length > 0 ? (
            <Section title="Ready with your accounts" items={ready} installedIds={installedIds} />
          ) : null}
          {rest.length > 0 ? (
            <Section
              title="Needs setup or a plan change"
              items={rest}
              installedIds={installedIds}
            />
          ) : null}

          {shown.length === 0 ? (
            <p className="py-16 text-center text-sm text-ink-3">
              Nothing matches those filters.
            </p>
          ) : null}
        </div>
      </div>
    </div>
  );
}

function Section({
  title,
  items,
  installedIds,
}: {
  title: string;
  items: {
    product: {
      id: string;
      slug: string;
      title: string;
      summary: string;
      category: string;
      kind: "AGENT" | "WORKFLOW";
      version: string;
      ratingAvg: number;
      ratingCount: number;
      runsLast30d: number;
      healthPct: number;
      status: string;
    };
    readiness: Readiness;
  }[];
  installedIds: Set<string>;
}) {
  return (
    <section className="flex flex-col gap-1">
      <h2 className="mt-1 text-[15px] font-semibold">{title}</h2>
      <div className="grid grid-cols-1 gap-x-7 xl:grid-cols-2">
        {items.map(({ product, readiness }) => (
          <Link
            key={product.id}
            href={`/marketplace/${product.slug}`}
            className="group flex gap-3.5 border-b border-[#f0f0f0] py-3.5"
          >
            <ProductGlyph category={product.category} kind={product.kind} size={48} />
            <div className="flex min-w-0 flex-1 flex-col gap-[3px]">
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-[15px] font-medium">{product.title}</span>
                <Badge tone={installedIds.has(product.id) ? "neutral" : readiness.tone}>
                  {installedIds.has(product.id) ? "In workspace" : readiness.label}
                </Badge>
              </div>
              <p className="text-[13px] leading-snug text-ink-2">{product.summary}</p>
              <p className="mt-[3px] text-xs text-ink-3">
                {product.kind === "AGENT" ? "Agent" : "Workflow"} · {product.category}{" "}
                · v{product.version}
                {product.ratingCount > 0
                  ? ` · ${product.ratingAvg.toFixed(1)} ★ (${product.ratingCount})`
                  : ""}
                {product.status === "RESTRICTED"
                  ? " · health degraded"
                  : product.runsLast30d > 0
                    ? ` · ${compactRuns(product.runsLast30d)} runs`
                    : ""}
              </p>
            </div>
            <span className="flex size-8 flex-none items-center justify-center rounded-full text-ink-3 group-hover:bg-fill group-hover:text-ink">
              <ArrowUpRight size={17} strokeWidth={1.8} />
            </span>
          </Link>
        ))}
      </div>
    </section>
  );
}
