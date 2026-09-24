import Link from "next/link";
import { notFound } from "next/navigation";
import { BadgeCheck, HeartPulse, ShieldCheck, Sparkles } from "lucide-react";
import { prisma } from "@/lib/db";
import { requireUser } from "@/lib/auth";
import {
  Badge,
  ButtonLink,
  Card,
  Divider,
  FootNote,
  Mono,
  SectionLabel,
} from "@/components/ds";
import { ProductGlyph } from "@/components/app/product-glyph";
import { readinessFor, relativeDays } from "@/lib/readiness";

type InputField = { name: string; label: string; type: string; required?: boolean; note?: string };
type Output = { name: string; note: string };

export async function generateMetadata({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;
  const product = await prisma.product.findUnique({
    where: { slug },
    select: { title: true },
  });
  return { title: product ? `${product.title} · Builder` : "Builder" };
}

export default async function ProductPage({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;
  const user = await requireUser();

  const product = await prisma.product.findUnique({
    where: { slug },
    include: {
      creator: true,
      requirements: { orderBy: { sortOrder: "asc" } },
      versions: { orderBy: { version: "desc" } },
      reviews: { include: { user: true }, orderBy: { createdAt: "desc" }, take: 5 },
    },
  });
  if (!product) notFound();

  const monthStart = new Date(
    Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth(), 1),
  );

  const [accounts, installation, runsThisMonth] = await Promise.all([
    prisma.connectedAccount.findMany({ where: { userId: user.id } }),
    prisma.installation.findFirst({
      where: { userId: user.id, productId: product.id },
    }),
    prisma.run.count({
      where: { userId: user.id, startedAt: { gte: monthStart }, charged: true },
    }),
  ]);

  const installed = Boolean(installation && installation.status !== "UNINSTALLED");
  const readiness = readinessFor({
    productStatus: product.status,
    requirements: product.requirements,
    accounts,
    installed,
    installationStatus: installation?.status,
    overPlanLimit:
      runsThisMonth >= user.plan.monthlyRuns ||
      (product.usesCredits && user.credits <= 0),
  });

  const inputs = (product.inputSchema as unknown as InputField[]) ?? [];
  const outputs = (product.outputs as unknown as Output[]) ?? [];
  const platformProvided = product.requirements.filter(
    (r) => r.providedBy !== "USER",
  ).length;

  const usable = new Set(
    accounts.filter((a) => a.status === "ACTIVE").map((a) => a.credentialType),
  );

  return (
    <div className="px-5 py-5 pb-14 lg:px-7">
      <nav className="flex items-center gap-1.5 text-[13px] text-ink-3">
        <Link href="/marketplace" className="text-ink-2 hover:text-ink">
          Marketplace
        </Link>
        <span>/</span>
        <Link
          href={`/marketplace?category=${encodeURIComponent(product.category)}`}
          className="text-ink-2 hover:text-ink"
        >
          {product.category}
        </Link>
        <span>/</span>
        <span className="text-ink">{product.title}</span>
      </nav>

      <div className="mt-5 grid grid-cols-1 gap-8 lg:grid-cols-[minmax(0,1fr)_300px]">
        <div className="flex flex-col gap-7">
          <header className="flex gap-4">
            <ProductGlyph category={product.category} kind={product.kind} size={56} />
            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-2">
                <Badge tone="neutral">
                  {product.kind === "AGENT" ? "Agent" : "Workflow"}
                </Badge>
                <Badge tone="neutral">{product.category}</Badge>
                <Mono>
                  v{product.version} · updated {relativeDays(product.updatedAt)}
                </Mono>
              </div>
              <h1 className="mt-2 text-[22px] font-semibold tracking-[-0.01em]">
                {product.title}
              </h1>
              <p className="mt-1 text-[13px] text-ink-3">
                by {product.creator.creatorName ?? product.creator.name}
                {product.creator.creatorVerified ? " · Creator verified" : ""}
                {product.ratingCount > 0
                  ? ` · ${product.ratingAvg.toFixed(1)} ★ (${product.ratingCount} reviews)`
                  : ""}
                {product.runsLast30d > 0
                  ? ` · ${product.runsLast30d.toLocaleString()} runs this month`
                  : ""}
              </p>
            </div>
          </header>

          <div className="grid grid-cols-1 gap-6 sm:grid-cols-2">
            <div>
              <SectionLabel>What it does</SectionLabel>
              <p className="mt-2 text-sm leading-relaxed text-ink-2">
                {product.description}
              </p>
            </div>
            <div>
              <SectionLabel>What it needs from you</SectionLabel>
              <p className="mt-2 text-sm leading-relaxed text-ink-2">
                {product.needsFromYou}
              </p>
            </div>
          </div>

          <div>
            <div className="flex flex-wrap items-center gap-2">
              <SectionLabel>Does it work for me</SectionLabel>
              <Badge tone={readiness.tone}>{readiness.label}</Badge>
              {readiness.missing.length > 0 ? (
                <span className="text-[13px] text-ink-2">
                  — {readiness.missing.length} of{" "}
                  {
                    product.requirements.filter((r) => r.kind === "CONNECTION")
                      .length
                  }{" "}
                  connections missing.
                </span>
              ) : null}
            </div>

            <Card className="mt-3 overflow-hidden">
              <table className="w-full border-collapse text-sm">
                <thead>
                  <tr>
                    <th className="border-b border-selected px-4 py-2.5 text-left text-xs font-normal text-ink-3">
                      Requirement
                    </th>
                    <th className="border-b border-selected px-4 py-2.5 text-left text-xs font-normal text-ink-3">
                      Provided by
                    </th>
                    <th className="border-b border-selected px-4 py-2.5 text-left text-xs font-normal text-ink-3">
                      Status
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {product.requirements.map((requirement) => {
                    const satisfied =
                      requirement.providedBy !== "USER" ||
                      (requirement.credentialType
                        ? usable.has(requirement.credentialType)
                        : false);
                    return (
                      <tr key={requirement.id}>
                        <td className="border-b border-selected px-4 py-3 last:border-0">
                          {requirement.label}
                          {requirement.note ? (
                            <span className="text-ink-3"> {requirement.note}</span>
                          ) : null}
                        </td>
                        <td className="border-b border-selected px-4 py-3 text-ink-2">
                          {requirement.providedBy === "PLATFORM"
                            ? "Platform"
                            : requirement.providedBy === "PLATFORM_OR_OWN"
                              ? "Platform · your account allowed"
                              : "You"}
                        </td>
                        <td className="border-b border-selected px-4 py-3">
                          {satisfied ? (
                            <Badge tone="ready">Ready</Badge>
                          ) : (
                            <Link
                              href="/accounts"
                              className="text-[13px] font-medium"
                            >
                              Connect
                            </Link>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </Card>

            {product.externalHosts.length > 0 ? (
              <FootNote>
                <span className="mt-2 block">
                  Connects to {product.externalHosts.join(", ")}. You see every
                  service a product reaches before you add it.
                </span>
              </FootNote>
            ) : null}
          </div>

          <div className="grid grid-cols-1 gap-6 sm:grid-cols-2">
            <div>
              <SectionLabel>Inputs</SectionLabel>
              <ul className="mt-2 flex flex-col gap-1.5 text-sm">
                {inputs.map((field) => (
                  <li key={field.name}>
                    {field.label}
                    <span className="text-ink-3">
                      {" "}
                      · {field.note ?? (field.required === false ? "optional" : "required")}
                    </span>
                  </li>
                ))}
              </ul>
            </div>
            <div>
              <SectionLabel>Outputs</SectionLabel>
              <ul className="mt-2 flex flex-col gap-1.5 text-sm">
                {outputs.map((output) => (
                  <li key={output.name}>
                    {output.name}
                    <span className="text-ink-3"> · {output.note}</span>
                  </li>
                ))}
              </ul>
            </div>
          </div>

          {product.reviews.length > 0 ? (
            <div>
              <div className="flex items-baseline gap-2">
                <SectionLabel>Reviews</SectionLabel>
                <span className="text-xs text-ink-3">· from people who ran it</span>
              </div>
              <div className="mt-3 flex flex-col gap-3">
                {product.reviews.map((review) => (
                  <div key={review.id}>
                    <Mono>
                      {review.rating} ★ · {review.user.name} ·{" "}
                      {relativeDays(review.createdAt)}
                    </Mono>
                    <p className="mt-1 text-sm text-ink-2">{review.body}</p>
                  </div>
                ))}
              </div>
            </div>
          ) : null}
        </div>

        <aside className="flex flex-col gap-6">
          <Card className="flex flex-col gap-3 p-4">
            <div className="flex items-center justify-between">
              <SectionLabel>Your setup status</SectionLabel>
              <Badge tone={readiness.tone}>{readiness.label}</Badge>
            </div>
            <p className="text-[13px] leading-relaxed text-ink-2">
              {platformProvided} requirement{platformProvided === 1 ? "" : "s"}{" "}
              provided by the platform.
              {readiness.missing.length > 0
                ? ` ${readiness.missing.length} needs your account.`
                : " Nothing left to connect."}
            </p>

            {product.status === "RESTRICTED" && !installed ? (
              <>
                <span className="inline-flex h-10 items-center justify-center rounded-full bg-selected px-[18px] text-sm font-medium text-ink-3">
                  Restricted
                </span>
                <FootNote>{product.restrictionNote}</FootNote>
              </>
            ) : installed ? (
              <ButtonLink href="/workspace">Open in My workspace</ButtonLink>
            ) : (
              <ButtonLink href={`/marketplace/${product.slug}/setup`}>
                Add to workspace
              </ButtonLink>
            )}

            {/*
              The design also draws a "Try with sample data" button here. It is
              not rendered, because there is no contract behind it: nothing says
              what the sample data would be, and a trial run would execute the
              creator's real workflow — which for a product that writes means
              real messages sent on the user's behalf. The Inputs and Outputs
              sections above already answer what a trial is usually asked for,
              which is what this product will want and what it hands back.
            */}
            <FootNote>
              Adding pins you to v{product.version}. You choose when to upgrade.
            </FootNote>
          </Card>

          <div>
            <SectionLabel>Trust</SectionLabel>
            <div className="mt-2.5 flex flex-col gap-2.5 text-[13px]">
              <TrustRow
                icon={<ShieldCheck size={16} strokeWidth={1.8} />}
                label="Security checked"
                value={`v${product.version}`}
              />
              <TrustRow
                icon={<Sparkles size={16} strokeWidth={1.8} />}
                label="Compatible"
                value={`v${product.version}`}
              />
              <TrustRow
                icon={<BadgeCheck size={16} strokeWidth={1.8} />}
                label={
                  product.platformApproved ? "Platform approved" : "Not yet approved"
                }
                value={`v${product.version}`}
              />
              <TrustRow
                icon={<BadgeCheck size={16} strokeWidth={1.8} />}
                label={
                  product.creator.creatorVerified
                    ? "Creator verified"
                    : "Creator unverified"
                }
                value="account"
              />
              <TrustRow
                icon={<HeartPulse size={16} strokeWidth={1.8} />}
                label={product.healthPct >= 95 ? "Healthy" : "Degraded"}
                value={`${product.healthPct.toFixed(1)}% · 30d`}
              />
            </div>
            <FootNote>
              <span className="mt-2.5 block">
                Signals belong to this version. A new version is re-checked from
                scratch.
              </span>
            </FootNote>
          </div>

          {product.versions.length > 0 ? (
            <div>
              <SectionLabel>Versions</SectionLabel>
              <div className="mt-2.5 flex flex-col">
                {product.versions.map((version) => (
                  <div key={version.id}>
                    <div className="flex items-center justify-between py-2 text-[13px]">
                      <Mono>v{version.version}</Mono>
                      <span className="text-ink-3">
                        {version.current
                          ? "current"
                          : version.deprecated
                            ? "deprecated"
                            : relativeDays(version.publishedAt)}
                      </span>
                    </div>
                    <Divider />
                  </div>
                ))}
              </div>
            </div>
          ) : null}
        </aside>
      </div>
    </div>
  );
}

function TrustRow({
  icon,
  label,
  value,
}: {
  icon: React.ReactNode;
  label: string;
  value: string;
}) {
  return (
    <div className="flex items-center gap-2.5">
      <span className="flex-none text-ink-2">{icon}</span>
      <span className="flex-1">{label}</span>
      <span className="font-mono text-xs text-ink-3">{value}</span>
    </div>
  );
}
