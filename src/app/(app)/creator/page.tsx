import Link from "next/link";
import { prisma } from "@/lib/db";
import { requireRole } from "@/lib/auth";
import {
  Badge,
  Button,
  ButtonLink,
  Card,
  FootNote,
  PageTitle,
  SectionLabel,
  Textarea,
} from "@/components/ds";
import { formatDate, formatDuration, waitingFor } from "@/lib/readiness";
import { answerIssue, resubmit } from "@/server/creator-actions";
import type { CheckState, IssueSeverity, ProductStatus } from "@/generated/prisma";

export const metadata = { title: "Creator studio · Builder" };

const TABS = ["My products", "Analytics", "Reviews", "Payouts · later"] as const;

const CHECK_TONE: Record<CheckState, "ready" | "partial" | "blocked" | "neutral"> = {
  PASSED: "ready",
  FIXED: "neutral",
  PARTIAL: "partial",
  HUMAN_REVIEW: "partial",
  FAILED: "blocked",
};

const CHECK_LABEL: Record<CheckState, string> = {
  PASSED: "Passed",
  FIXED: "Fixed for you",
  PARTIAL: "Partial",
  HUMAN_REVIEW: "Human review",
  FAILED: "Failed",
};

const SEVERITY: Record<IssueSeverity, { tone: "blocked" | "partial" | "ready" | "neutral"; label: string }> = {
  BLOCKER: { tone: "blocked", label: "Blocker" },
  HUMAN_REVIEW: { tone: "partial", label: "Human review" },
  FIXED: { tone: "ready", label: "Fixed for you" },
  QUALITY: { tone: "neutral", label: "Quality" },
  POLICY: { tone: "neutral", label: "Policy" },
};

function statusLine(status: ProductStatus) {
  switch (status) {
    case "PUBLISHED":
      return "Published";
    case "IN_REVIEW":
      return "Under review";
    case "RESTRICTED":
      return "Restricted · health degraded";
    case "BLOCKED_DURABILITY":
      return "Blocked · connection has no sign-in flow";
    case "SECURITY_HOLD":
      return "On hold · security";
    case "DRAFT":
      return "Draft";
    default:
      return status.toLowerCase().replace(/_/g, " ");
  }
}

export default async function CreatorPage({
  searchParams,
}: {
  searchParams: Promise<{ submission?: string }>;
}) {
  const { submission: submissionId } = await searchParams;
  const creator = await requireRole("CREATOR");

  const [products, submissions] = await Promise.all([
    prisma.product.findMany({
      where: { creatorId: creator.id },
      include: {
        _count: { select: { installations: true } },
      },
      orderBy: { updatedAt: "desc" },
    }),
    prisma.submission.findMany({
      where: { creatorId: creator.id },
      include: { product: true, issues: true },
      orderBy: { submittedAt: "desc" },
    }),
  ]);

  const selected =
    submissions.find((item) => item.id === submissionId) ?? submissions[0];

  const runStats = await prisma.run.groupBy({
    by: ["productId", "result"],
    where: { productId: { in: products.map((product) => product.id) } },
    _count: { _all: true },
  });

  const successRate = new Map<string, number>();
  for (const product of products) {
    const rows = runStats.filter((row) => row.productId === product.id);
    const total = rows.reduce((sum, row) => sum + row._count._all, 0);
    const ok = rows
      .filter((row) => row.result === "SUCCESS")
      .reduce((sum, row) => sum + row._count._all, 0);
    if (total > 0) successRate.set(product.id, (ok / total) * 100);
  }

  const blockers =
    selected?.issues.filter(
      (issue) => issue.severity === "BLOCKER" || (issue.needsAnswer && !issue.answer),
    ) ?? [];

  return (
    <div className="px-5 py-5 lg:px-7">
      <PageTitle
        title="Creator studio"
        actions={<ButtonLink href="/creator/upload" size="sm">Upload a product</ButtonLink>}
      />

      <nav className="mt-4 flex gap-1 overflow-x-auto text-sm">
        {TABS.map((tab, index) => (
          <span
            key={tab}
            className={
              index === 0
                ? "rounded-full bg-fill px-3.5 py-[7px] font-medium whitespace-nowrap text-ink"
                : "rounded-full px-3.5 py-[7px] whitespace-nowrap text-ink-3"
            }
          >
            {tab}
          </span>
        ))}
      </nav>

      <div className="mt-5 grid grid-cols-1 gap-7 lg:grid-cols-[300px_minmax(0,1fr)]">
        <div className="flex flex-col">
          <SectionLabel className="pb-2">My products</SectionLabel>
          {products.map((product) => {
            const productSubmission = submissions.find(
              (item) => item.productId === product.id,
            );
            const failed = productSubmission?.state === "VALIDATION_FAILED";
            const issues = productSubmission?.issues.length ?? 0;
            return (
              <Link
                key={product.id}
                href={
                  productSubmission
                    ? `/creator?submission=${productSubmission.id}`
                    : "/creator"
                }
                className={
                  selected?.productId === product.id
                    ? "rounded-row bg-fill px-3 py-2.5"
                    : "rounded-row px-3 py-2.5 hover:bg-fill/60"
                }
              >
                <div className="text-sm font-medium text-ink">{product.title}</div>
                <div className="mt-0.5 text-xs text-ink-3">
                  v{failed ? productSubmission!.version : product.version} ·{" "}
                  {failed ? `Validation failed · ${issues} issues` : statusLine(product.status)}
                  {product.status === "PUBLISHED" && product.runsLast30d > 0
                    ? ` · ${product.runsLast30d.toLocaleString()} runs`
                    : ""}
                </div>
              </Link>
            );
          })}

          {products.length === 0 ? (
            <p className="px-3 py-6 text-sm text-ink-3">
              Nothing uploaded yet.
            </p>
          ) : null}

          {products.some((product) => successRate.has(product.id)) ? (
            <div className="mt-6">
              <SectionLabel className="pb-2">Run success</SectionLabel>
              {products
                .filter((product) => successRate.has(product.id))
                .map((product) => (
                  <div
                    key={product.id}
                    className="flex items-center justify-between border-b border-selected py-2 text-[13px]"
                  >
                    <span className="truncate">{product.title}</span>
                    <span className="font-mono text-xs text-ink-3">
                      {successRate.get(product.id)!.toFixed(0)}% ·{" "}
                      {product._count.installations} users
                    </span>
                  </div>
                ))}
            </div>
          ) : null}
        </div>

        {selected ? (
          <div className="flex flex-col gap-5">
            <div>
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-xs text-ink-3">
                  Submission · v{selected.version}
                </span>
                <h2 className="text-[15px] font-semibold">
                  {selected.product.title}
                </h2>
                <Badge
                  tone={
                    selected.state === "VALIDATION_FAILED"
                      ? "blocked"
                      : selected.state === "UNDER_REVIEW"
                        ? "partial"
                        : "ready"
                  }
                >
                  {selected.state === "VALIDATION_FAILED"
                    ? "Validation failed"
                    : selected.state === "UNDER_REVIEW"
                      ? "Under review"
                      : selected.state.toLowerCase().replace(/_/g, " ")}
                </Badge>
              </div>
              <p className="mt-1 text-xs text-ink-3">
                Submitted {formatDate(selected.submittedAt)} · automated checks
                finished in {formatDuration(selected.checkDurationMs ?? 0)}
                {selected.state === "UNDER_REVIEW"
                  ? ` · waiting ${waitingFor(selected.submittedAt)}`
                  : ""}
              </p>
            </div>

            <div className="flex flex-wrap gap-2">
              <Check label="Parsing" state={selected.parsing} />
              <Check
                label="Secrets"
                state={selected.secrets}
                override={
                  selected.secretsRemoved > 0
                    ? `${selected.secretsRemoved} removed`
                    : undefined
                }
              />
              <Check label="Compatibility" state={selected.compatibility} />
              <Check label="Security" state={selected.security} />
              <Check label="Quality" state={selected.quality} />
              <Check label="Policy" state={selected.policy} />
            </div>

            {selected.issues.length > 0 ? (
              <div>
                <SectionLabel>What to fix</SectionLabel>
                <div className="mt-2.5 flex flex-col gap-2">
                  {selected.issues.map((issue) => {
                    const severity = SEVERITY[issue.severity];
                    return (
                      <Card
                        key={issue.id}
                        tone={issue.severity === "BLOCKER" ? "danger" : "plain"}
                        className="flex flex-col gap-2 p-3.5"
                      >
                        <div className="flex flex-wrap items-center gap-2">
                          <span className="text-sm font-medium">{issue.title}</span>
                          <Badge tone={severity.tone}>{severity.label}</Badge>
                          {issue.step ? (
                            <span className="text-xs text-ink-3">{issue.step}</span>
                          ) : null}
                        </div>
                        <p className="text-[13px] leading-relaxed text-ink-2">
                          {issue.detail}
                        </p>

                        {issue.needsAnswer ? (
                          issue.answer ? (
                            <p className="rounded-row bg-fill p-2.5 text-[13px] text-ink-2">
                              {issue.answer}
                            </p>
                          ) : (
                            <form
                              action={answerIssue}
                              className="flex flex-col gap-2"
                            >
                              <input type="hidden" name="issueId" value={issue.id} />
                              <Textarea
                                name="answer"
                                rows={2}
                                placeholder="Explain why this step calls this address…"
                              />
                              <Button type="submit" size="sm" className="self-start">
                                Send to the reviewer
                              </Button>
                            </form>
                          )
                        ) : null}
                      </Card>
                    );
                  })}
                </div>
              </div>
            ) : (
              <p className="text-sm text-ink-2">
                Nothing to fix. This version is with a reviewer.
              </p>
            )}

            <div className="flex flex-wrap items-center gap-3 border-t border-selected pt-4">
              <FootNote>
                v{selected.product.version} stays published and unaffected.
                Existing users keep their version until they upgrade.
              </FootNote>
              <div className="ml-auto flex gap-2">
                <ButtonLink href="/creator/upload" tone="secondary" size="sm">
                  Upload fixed file
                </ButtonLink>
                <form action={resubmit}>
                  <input type="hidden" name="submissionId" value={selected.id} />
                  <Button
                    type="submit"
                    size="sm"
                    tone={blockers.length > 0 ? "quiet" : "primary"}
                    disabled={blockers.length > 0}
                  >
                    Resubmit
                  </Button>
                </form>
              </div>
            </div>
          </div>
        ) : (
          <p className="text-sm text-ink-3">
            No submissions yet. <Link href="/creator/upload">Upload a product</Link>.
          </p>
        )}
      </div>
    </div>
  );
}

function Check({
  label,
  state,
  override,
}: {
  label: string;
  state: CheckState;
  override?: string;
}) {
  return (
    <span className="flex items-center gap-2 rounded-full border border-selected py-1.5 pr-2 pl-3 text-[13px]">
      {label}
      <Badge tone={CHECK_TONE[state]}>{override ?? CHECK_LABEL[state]}</Badge>
    </span>
  );
}
