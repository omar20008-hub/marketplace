import Link from "next/link";
import { CircleAlert } from "lucide-react";
import { prisma } from "@/lib/db";
import { requireUser } from "@/lib/auth";
import {
  Button,
  ButtonLink,
  Card,
  Divider,
  FootNote,
  PageTitle,
  SectionLabel,
} from "@/components/ds";
import { ProductGlyph } from "@/components/app/product-glyph";
import { runFromWorkspace } from "@/server/run-actions";
import { UninstallButton } from "./uninstall-button";
import { formatBytes, readinessFor, relativeDays } from "@/lib/readiness";

export const metadata = { title: "My workspace · Builder" };

type Tab = "all" | "agents" | "workflows" | "attention" | "favourites";

export default async function WorkspacePage({
  searchParams,
}: {
  searchParams: Promise<{ tab?: Tab }>;
}) {
  const { tab = "all" } = await searchParams;
  const user = await requireUser();

  const monthStart = new Date(
    Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth(), 1),
  );

  const [installations, accounts, runCounts, runsThisMonth, storage, schedules, artifactCount] =
    await Promise.all([
      prisma.installation.findMany({
        where: { userId: user.id, status: { in: ["ACTIVE", "PARTIAL", "DISABLED"] } },
        include: { product: { include: { requirements: true } } },
        orderBy: { installedAt: "asc" },
      }),
      prisma.connectedAccount.findMany({ where: { userId: user.id } }),
      prisma.run.groupBy({
        by: ["installationId"],
        where: { userId: user.id },
        _count: { _all: true },
      }),
      prisma.run.count({
        where: { userId: user.id, startedAt: { gte: monthStart }, charged: true },
      }),
      prisma.artifact.aggregate({
        where: { run: { userId: user.id } },
        _sum: { sizeBytes: true },
      }),
      prisma.schedule.count({ where: { userId: user.id } }),
      prisma.artifact.count({ where: { run: { userId: user.id } } }),
    ]);

  const runsBy = new Map(runCounts.map((row) => [row.installationId, row._count._all]));

  const rows = installations.map((installation) => ({
    installation,
    readiness: readinessFor({
      productStatus: installation.product.status,
      requirements: installation.product.requirements,
      accounts,
      installed: true,
      installationStatus: installation.status,
    }),
    runs: runsBy.get(installation.id) ?? 0,
  }));

  const attention = rows.filter(
    (row) =>
      row.readiness.tone === "partial" ||
      row.readiness.tone === "blocked" ||
      row.installation.product.status === "RESTRICTED",
  );

  const visible = rows.filter((row) => {
    switch (tab) {
      case "agents":
        return row.installation.product.kind === "AGENT";
      case "workflows":
        return row.installation.product.kind === "WORKFLOW";
      case "attention":
        return attention.includes(row);
      case "favourites":
        return row.installation.favourite;
      default:
        return true;
    }
  });

  const agents = visible.filter((row) => row.installation.product.kind === "AGENT");
  const workflows = visible.filter(
    (row) => row.installation.product.kind === "WORKFLOW",
  );

  const usedBytes = storage._sum.sizeBytes ?? 0;
  const quotaBytes = Number(user.plan.storageBytes);

  const TABS: { key: Tab; label: string; badge?: number }[] = [
    { key: "all", label: "All" },
    { key: "agents", label: "Agents" },
    { key: "workflows", label: "Workflows" },
    { key: "attention", label: "Needs attention", badge: attention.length },
    { key: "favourites", label: "Favourites" },
  ];

  return (
    <div className="px-5 py-5 lg:px-7">
      <PageTitle
        title="My workspace"
        meta={`· ${rows.length} products · ${attention.length} need attention`}
      />

      <nav className="mt-4 flex gap-1 overflow-x-auto text-sm">
        {TABS.map((item) => (
          <Link
            key={item.key}
            href={item.key === "all" ? "/workspace" : `/workspace?tab=${item.key}`}
            className={
              item.key === tab
                ? "flex items-center gap-1.5 rounded-full bg-fill px-3.5 py-[7px] font-medium whitespace-nowrap text-ink"
                : "flex items-center gap-1.5 rounded-full px-3.5 py-[7px] whitespace-nowrap text-ink-2 hover:text-ink"
            }
          >
            {item.label}
            {item.badge ? (
              <span className="text-xs text-ink-3">{item.badge}</span>
            ) : null}
          </Link>
        ))}
      </nav>

      <div className="mt-5 grid grid-cols-1 gap-7 lg:grid-cols-[minmax(0,1fr)_280px]">
        <div className="flex flex-col gap-7">
          {tab !== "favourites" && attention.length > 0 ? (
            <section>
              <SectionLabel>Needs attention</SectionLabel>
              <div className="mt-2.5 flex flex-col gap-2">
                {attention.map(({ installation, readiness }) => (
                  <Card
                    key={installation.id}
                    tone="danger"
                    className="flex flex-wrap items-center gap-3 p-3.5"
                  >
                    <span className="flex size-10 flex-none items-center justify-center rounded-row bg-danger-tint text-danger-ink">
                      <CircleAlert size={18} strokeWidth={1.8} />
                    </span>
                    <div className="min-w-0 flex-1">
                      <div className="text-sm font-medium">
                        {installation.product.title}
                        <span className="font-normal text-ink-3">
                          {" "}
                          · {installation.product.kind === "AGENT" ? "Agent" : "Workflow"} · v
                          {installation.pinnedVersion}
                        </span>
                      </div>
                      {/* A connection problem outranks a restriction note: one
                          stops the next run, the other only stops new installs. */}
                      <p className="mt-0.5 text-[13px] leading-snug text-ink-2">
                        {readiness.missing.length > 0
                          ? `${readiness.missing.join(", ")} needs your attention.`
                          : (installation.attentionNote ??
                            installation.product.restrictionNote)}
                      </p>
                    </div>
                    {readiness.missing.length > 0 ? (
                      <ButtonLink href="/accounts" size="sm">
                        Reconnect
                      </ButtonLink>
                    ) : (
                      <ButtonLink
                        href={`/marketplace/${installation.product.slug}`}
                        tone="secondary"
                        size="sm"
                      >
                        Details
                      </ButtonLink>
                    )}
                  </Card>
                ))}
              </div>
            </section>
          ) : null}

          {agents.length > 0 ? (
            <ProductList title="My agents" rows={agents} />
          ) : null}
          {workflows.length > 0 ? (
            <ProductList title="My workflows" rows={workflows} />
          ) : null}

          {visible.length === 0 ? (
            <p className="py-12 text-center text-sm text-ink-3">
              Nothing here yet.{" "}
              <Link href="/marketplace">Browse the Marketplace</Link>.
            </p>
          ) : null}
        </div>

        <aside className="flex flex-col gap-5">
          <Card className="flex flex-col gap-3 p-4">
            <div className="flex items-center justify-between">
              <SectionLabel>Plan</SectionLabel>
              <span className="text-[13px] font-medium">{user.plan.name}</span>
            </div>
            <div className="flex items-center justify-between text-xs text-ink-3">
              <button type="button" className="text-link hover:text-link-strong">
                Manage
              </button>
              <span>
                Renews{" "}
                {user.renewsAt
                  ? new Intl.DateTimeFormat("en-GB", {
                      day: "numeric",
                      month: "short",
                      timeZone: "UTC",
                    }).format(user.renewsAt)
                  : "—"}
              </span>
            </div>

            <Divider />

            <Meter
              label="Runs this month"
              value={`${runsThisMonth.toLocaleString()} of ${user.plan.monthlyRuns.toLocaleString()}`}
              ratio={runsThisMonth / user.plan.monthlyRuns}
            />
            <Meter
              label="Storage"
              value={`${formatBytes(usedBytes)} of ${formatBytes(quotaBytes)}`}
              ratio={usedBytes / quotaBytes}
            />
            <div className="flex items-baseline justify-between">
              <span className="text-[13px]">Credits</span>
              <span className="text-[13px] font-medium">
                {user.credits.toLocaleString()}
              </span>
            </div>
            <FootNote>
              Spent only when you pick a specific model. Running out never stops
              your plan&apos;s normal use.
            </FootNote>
          </Card>

          <div>
            <SectionLabel>Also here</SectionLabel>
            <div className="mt-2 flex flex-col">
              <RailLink
                href="/accounts"
                label="Connected accounts"
                value={String(accounts.filter((a) => a.status !== "PENDING").length)}
              />
              <RailLink
                href="/results"
                label="Results"
                value={`${artifactCount} files`}
              />
              <RailLink
                href="/results?view=schedules"
                label="Schedules"
                value={String(schedules)}
              />
              <RailLink href="/accounts" label="Settings" value="" />
            </div>
          </div>
        </aside>
      </div>
    </div>
  );
}

function ProductList({
  title,
  rows,
}: {
  title: string;
  rows: {
    installation: {
      id: string;
      favourite: boolean;
      lastRunAt: Date | null;
      activationStatus: string;
      product: {
        slug: string;
        title: string;
        category: string;
        kind: "AGENT" | "WORKFLOW";
        ratingAvg: number;
        invocationMode: string;
      };
    };
    readiness: { tone: "ready" | "partial" | "plan" | "blocked" | "restricted" | "platform" | "neutral"; label: string };
    runs: number;
  }[];
}) {
  return (
    <section>
      <div className="flex items-baseline gap-2">
        <SectionLabel>{title}</SectionLabel>
        <span className="text-xs text-ink-3">· {rows.length}</span>
      </div>
      <div className="mt-2.5 flex flex-col">
        {rows.map(({ installation, readiness, runs }) => (
          <div
            key={installation.id}
            className="flex flex-wrap items-center gap-3 border-b border-selected py-3"
          >
            <ProductGlyph
              category={installation.product.category}
              kind={installation.product.kind}
              size={40}
            />
            <div className="min-w-0 flex-1">
              <Link
                href={`/marketplace/${installation.product.slug}`}
                className="text-sm font-medium text-ink hover:underline"
              >
                {installation.product.title}
              </Link>
              <div className="mt-0.5 text-xs text-ink-3">
                {readiness.label}
                {runs > 0 ? ` · ${runs} run${runs === 1 ? "" : "s"}` : ""}
                {installation.lastRunAt
                  ? ` · ran ${relativeDays(installation.lastRunAt)}`
                  : ""}
                {installation.product.ratingAvg > 0
                  ? ` · ${installation.product.ratingAvg.toFixed(1)} ★`
                  : ""}
              </div>
            </div>

            {readiness.tone === "ready" &&
            installation.product.invocationMode !== "on_demand" ? (
              installation.activationStatus === "activation_failed" ? (
                <span className="inline-flex items-center gap-1.5 rounded-full bg-danger-tint px-3 py-1.5 text-[13px] font-medium text-danger-ink">
                  <CircleAlert size={14} strokeWidth={2} />
                  Activation failed — needs review
                </span>
              ) : (
                <span className="inline-flex items-center rounded-full bg-fill px-3 py-1.5 text-[13px] text-ink-2">
                  Runs automatically
                </span>
              )
            ) : readiness.tone === "ready" ? (
              <form action={runFromWorkspace}>
                <input
                  type="hidden"
                  name="installationId"
                  value={installation.id}
                />
                <Button type="submit" size="sm">
                  Run
                </Button>
              </form>
            ) : (
              <ButtonLink
                href={`/marketplace/${installation.product.slug}/setup`}
                tone="secondary"
                size="sm"
              >
                Finish setup
              </ButtonLink>
            )}

            <UninstallButton
              installationId={installation.id}
              title={installation.product.title}
            />
          </div>
        ))}
      </div>
    </section>
  );
}

function Meter({
  label,
  value,
  ratio,
}: {
  label: string;
  value: string;
  ratio: number;
}) {
  const pct = Math.min(100, Math.max(0, ratio * 100));
  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-baseline justify-between">
        <span className="text-[13px]">{label}</span>
        <span className="text-[13px] text-ink-2">{value}</span>
      </div>
      <div className="h-1.5 overflow-hidden rounded-full bg-fill">
        <div
          className={pct >= 90 ? "h-full bg-warn" : "h-full bg-ink"}
          style={{ width: `${pct}%` }}
        />
      </div>
    </div>
  );
}

function RailLink({
  href,
  label,
  value,
}: {
  href: string;
  label: string;
  value: string;
}) {
  return (
    <Link
      href={href}
      className="flex items-center justify-between border-b border-selected py-2.5 text-[13px] text-ink hover:text-link"
    >
      <span>{label}</span>
      <span className="text-ink-3">{value}</span>
    </Link>
  );
}
