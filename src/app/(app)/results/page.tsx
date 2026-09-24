import Link from "next/link";
import { notFound } from "next/navigation";
import { Download, FileSpreadsheet, Trash2 } from "lucide-react";
import { prisma } from "@/lib/db";
import { requireUser } from "@/lib/auth";
import {
  Badge,
  ButtonLink,
  Card,
  Divider,
  FootNote,
  Mono,
  PageTitle,
  SectionLabel,
  Table,
  Td,
  Th,
} from "@/components/ds";
import {
  formatBytes,
  formatDate,
  formatDuration,
  formatDay,
} from "@/lib/readiness";
import type { RunResult } from "@/generated/prisma";

export const metadata = { title: "Results · Builder" };

const VIEWS = ["runs", "artifacts", "schedules"] as const;
type View = (typeof VIEWS)[number];

const RESULT_LABEL: Record<RunResult, { label: string; tone: "ready" | "partial" | "blocked" | "neutral" }> = {
  RUNNING: { label: "Running", tone: "neutral" },
  SUCCESS: { label: "Succeeded", tone: "ready" },
  PARTIAL: { label: "Partial success", tone: "partial" },
  ERROR: { label: "Failed", tone: "blocked" },
  DENIED: { label: "Denied", tone: "blocked" },
  INCOMPLETE: { label: "Needs input", tone: "partial" },
  BLOCKED: { label: "Blocked", tone: "blocked" },
  STOPPED: { label: "Stopped", tone: "partial" },
};

export default async function ResultsPage({
  searchParams,
}: {
  searchParams: Promise<{ view?: View; run?: string; status?: string }>;
}) {
  const { view = "runs", run: selectedRunId, status } = await searchParams;
  if (!VIEWS.includes(view)) notFound();

  const user = await requireUser();

  const [runs, schedules, storage] = await Promise.all([
    prisma.run.findMany({
      where: {
        userId: user.id,
        ...(status ? { result: status as RunResult } : {}),
      },
      include: { product: true, artifacts: true },
      orderBy: { startedAt: "desc" },
      take: 100,
    }),
    prisma.schedule.findMany({
      where: { userId: user.id },
      include: { installation: { include: { product: true } } },
    }),
    prisma.artifact.aggregate({
      where: { run: { userId: user.id } },
      _sum: { sizeBytes: true },
    }),
  ]);

  const selected =
    runs.find((item) => item.runId === selectedRunId) ??
    runs.find((item) => item.artifacts.length > 0) ??
    runs[0];
  const artifact = selected?.artifacts[0];

  const usedBytes = storage._sum.sizeBytes ?? 0;
  const quotaBytes = Number(user.plan.storageBytes);

  return (
    <div className="px-5 py-5 lg:px-7">
      <PageTitle title="Results" />

      <nav className="mt-4 flex gap-1 text-sm">
        {VIEWS.map((item) => (
          <Link
            key={item}
            href={item === "runs" ? "/results" : `/results?view=${item}`}
            className={
              item === view
                ? "rounded-full bg-fill px-3.5 py-[7px] font-medium text-ink capitalize"
                : "rounded-full px-3.5 py-[7px] text-ink-2 capitalize hover:text-ink"
            }
          >
            {item}
          </Link>
        ))}
      </nav>

      <div className="mt-5 grid grid-cols-1 gap-6 xl:grid-cols-[minmax(0,1fr)_300px]">
        <div className="min-w-0">
          {view === "runs" ? (
            <>
              <Table>
                <thead>
                  <tr>
                    <Th>Product</Th>
                    <Th>Started</Th>
                    <Th>Duration</Th>
                    <Th>Status</Th>
                    <Th>Results</Th>
                    <Th>Cost</Th>
                  </tr>
                </thead>
                <tbody>
                  {runs.map((item) => {
                    const meta = RESULT_LABEL[item.result];
                    return (
                      <tr
                        key={item.id}
                        className={
                          selected?.id === item.id ? "bg-fill/60" : undefined
                        }
                      >
                        <Td className="whitespace-nowrap">
                          <Link
                            href={`/results?run=${item.runId}`}
                            className="text-ink hover:underline"
                          >
                            {item.product.title}
                          </Link>
                          <Mono className="ml-1.5">v{item.productVersion}</Mono>
                        </Td>
                        <Td className="whitespace-nowrap text-ink-2">
                          {formatDate(item.startedAt)}
                        </Td>
                        <Td className="whitespace-nowrap text-ink-2">
                          {formatDuration(item.durationMs)}
                        </Td>
                        <Td>
                          <Badge tone={meta.tone}>
                            {item.errorType && item.result !== "SUCCESS"
                              ? `${meta.label} · ${item.errorType}`
                              : meta.label}
                          </Badge>
                        </Td>
                        <Td className="whitespace-nowrap text-ink-2">
                          {item.artifacts.length > 0
                            ? `${item.artifacts.length} file${item.artifacts.length === 1 ? "" : "s"}`
                            : "—"}
                        </Td>
                        <Td className="whitespace-nowrap text-ink-2">
                          {!item.charged
                            ? (item.chargeNote ?? "not charged")
                            : item.costCredits > 0
                              ? `${item.costCredits} credits`
                              : "plan"}
                        </Td>
                      </tr>
                    );
                  })}
                </tbody>
              </Table>

              <div className="mt-3">
                <FootNote>
                  Runs that fail because of us are never counted against your
                  plan. Failures caused by your own inputs or your connected
                  service are.
                </FootNote>
              </div>
            </>
          ) : null}

          {view === "artifacts" ? (
            <div className="flex flex-col gap-2">
              {runs.flatMap((item) =>
                item.artifacts.map((file) => (
                  <Card
                    key={file.id}
                    className="flex flex-wrap items-center gap-3 p-3.5"
                  >
                    <span className="flex size-10 flex-none items-center justify-center rounded-row bg-ready-tint text-ready-ink">
                      <FileSpreadsheet size={18} strokeWidth={1.8} />
                    </span>
                    <div className="min-w-0 flex-1">
                      <div className="truncate text-sm font-medium">{file.name}</div>
                      <div className="mt-0.5 text-xs text-ink-3">
                        {formatBytes(file.sizeBytes)} · {item.product.title} v
                        {item.productVersion} · {formatDay(file.createdAt)}
                      </div>
                    </div>
                    <ButtonLink href={`/api/artifacts/${file.id}`} size="sm">
                      Open
                    </ButtonLink>
                  </Card>
                )),
              )}
              {runs.every((item) => item.artifacts.length === 0) ? (
                <p className="py-12 text-center text-sm text-ink-3">
                  No files yet.
                </p>
              ) : null}
            </div>
          ) : null}

          {view === "schedules" ? (
            <Table>
              <thead>
                <tr>
                  <Th>Product</Th>
                  <Th>When</Th>
                  <Th>Last status</Th>
                  <Th>State</Th>
                </tr>
              </thead>
              <tbody>
                {schedules.map((schedule) => (
                  <tr key={schedule.id}>
                    <Td>{schedule.installation.product.title}</Td>
                    <Td className="text-ink-2">{schedule.label}</Td>
                    <Td className="text-ink-2">{schedule.lastStatus ?? "—"}</Td>
                    <Td>
                      <Badge tone={schedule.enabled ? "ready" : "neutral"}>
                        {schedule.enabled ? "On" : "Paused"}
                      </Badge>
                    </Td>
                  </tr>
                ))}
              </tbody>
            </Table>
          ) : null}
        </div>

        <aside className="flex flex-col gap-5">
          {selected ? (
            <Card className="flex flex-col gap-3 p-4">
              <SectionLabel>Selected result</SectionLabel>

              {artifact ? (
                <>
                  <div className="flex h-28 items-center justify-center rounded-row bg-fill text-xs text-ink-3">
                    {artifact.mimeType.includes("spreadsheet")
                      ? "spreadsheet preview"
                      : artifact.mimeType.includes("pdf")
                        ? "document preview"
                        : "text preview"}
                  </div>
                  <div>
                    <div className="truncate text-sm font-medium">
                      {artifact.name}
                    </div>
                    <div className="mt-0.5 text-xs text-ink-3">
                      {formatBytes(artifact.sizeBytes)} ·{" "}
                      {artifact.mimeType.split("/").at(-1)}
                    </div>
                  </div>
                  <div className="flex flex-wrap gap-2">
                    <ButtonLink href={`/api/artifacts/${artifact.id}`} size="sm">
                      Open
                    </ButtonLink>
                    <ButtonLink
                      href={`/api/artifacts/${artifact.id}?download=1`}
                      tone="secondary"
                      size="sm"
                    >
                      <Download size={15} strokeWidth={1.8} />
                      Download
                    </ButtonLink>
                    <button
                      type="button"
                      className="inline-flex h-8 items-center gap-1.5 rounded-full px-3 text-[13px] text-ink-2 hover:text-danger-ink"
                    >
                      <Trash2 size={15} strokeWidth={1.8} />
                      Delete
                    </button>
                  </div>
                </>
              ) : (
                <p className="text-[13px] text-ink-2">
                  This run produced no file.
                </p>
              )}

              <Divider />

              <SectionLabel className="text-ink-3">Where it came from</SectionLabel>
              <dl className="flex flex-col gap-2 text-[13px]">
                <Row label="Product" value={selected.product.title} />
                <Row label="Version" value={`v${selected.productVersion}`} />
                <Row
                  label="Run"
                  value={`${selected.runId} · ${formatDate(selected.startedAt)}`}
                />
                <Row
                  label="Run by"
                  value={`${user.name}${user.orgName ? ` — ${user.orgName}` : ""}`}
                />
                <Row
                  label="Stored in"
                  value={
                    artifact
                      ? [
                          artifact.backend === "platform"
                            ? "Platform storage"
                            : artifact.backend,
                          ...artifact.deliveredTo,
                        ].join(" + ")
                      : "—"
                  }
                />
              </dl>
            </Card>
          ) : null}

          <Card className="flex flex-col gap-2 p-4">
            <div className="flex items-baseline justify-between">
              <SectionLabel>Storage</SectionLabel>
              <span className="text-[13px] text-ink-2">
                {formatBytes(usedBytes)} of {formatBytes(quotaBytes)}
              </span>
            </div>
            <div className="h-1.5 overflow-hidden rounded-full bg-fill">
              <div
                className="h-full bg-ink"
                style={{
                  width: `${Math.min(100, (usedBytes / quotaBytes) * 100)}%`,
                }}
              />
            </div>
          </Card>
        </aside>
      </div>
    </div>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex justify-between gap-3">
      <dt className="flex-none text-ink-3">{label}</dt>
      <dd className="min-w-0 text-right">{value}</dd>
    </div>
  );
}
