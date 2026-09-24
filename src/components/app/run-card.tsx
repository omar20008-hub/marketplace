import { CircleAlert, Download, FileSpreadsheet } from "lucide-react";
import {
  Badge,
  Button,
  ButtonLink,
  Card,
  Input,
  Mono,
} from "@/components/ds";
import { provideInputs } from "@/server/run-actions";
import { formatBytes, formatDate, formatDuration } from "@/lib/readiness";
import type { RunResult, StepStatus } from "@/generated/prisma";

type Step = { idx: number; label: string; status: StepStatus; durationMs: number | null };

type Artifact = {
  id: string;
  name: string;
  mimeType: string;
  sizeBytes: number;
  backend: string;
  deliveredTo: string[];
  keepDays: number;
};

export type RunCardData = {
  id: string;
  runId: string;
  result: RunResult;
  errorType: string | null;
  message: string | null;
  startedAt: Date;
  durationMs: number | null;
  charged: boolean;
  chargeNote: string | null;
  productVersion: string;
  steps: Step[];
  artifacts: Artifact[];
  product: {
    title: string;
    kind: "AGENT" | "WORKFLOW";
    slug: string;
    inputSchema: unknown;
  };
};

const stepDot: Record<StepStatus, string> = {
  DONE: "bg-ready",
  RUNNING: "bg-ink",
  QUEUED: "bg-line",
  FAILED: "bg-danger",
  SKIPPED: "bg-warn",
};

function extension(name: string) {
  const parts = name.split(".");
  return (parts.length > 1 ? parts.at(-1)! : "file").toUpperCase().slice(0, 4);
}

export function RunCard({ run }: { run: RunCardData }) {
  const done = run.steps.filter((step) => step.status === "DONE").length;
  const isRunning = run.result === "RUNNING";

  // Plan limit and connection blocks get the danger card from the design system.
  if (run.result === "BLOCKED") {
    const planLimit = run.errorType === "plan limit";
    return (
      <Card tone="danger" className="flex flex-col gap-3 p-4">
        <div className="flex gap-3">
          <span className="flex size-10 flex-none items-center justify-center rounded-row bg-danger-tint text-danger-ink">
            <CircleAlert size={19} strokeWidth={1.8} />
          </span>
          <div className="min-w-0 flex-1">
            <div className="text-sm font-medium">
              {planLimit
                ? "Blocked — monthly run limit reached"
                : "Blocked — a connection needs attention"}
            </div>
            <p className="mt-1 text-[13px] leading-relaxed text-ink-2">
              {run.message}
            </p>
          </div>
        </div>
        <div className="flex flex-wrap gap-2 sm:pl-[52px]">
          {planLimit ? (
            <>
              <ButtonLink href="/workspace" size="sm">
                See plan options
              </ButtonLink>
              <Button tone="secondary" size="sm">
                Notify me when it resets
              </Button>
            </>
          ) : (
            <ButtonLink href="/accounts" size="sm">
              Reconnect
            </ButtonLink>
          )}
        </div>
      </Card>
    );
  }

  // The deterministic validator refused to guess. Ask for exactly what it named.
  if (run.result === "INCOMPLETE") {
    const schema = Array.isArray(run.product.inputSchema)
      ? (run.product.inputSchema as { name: string; label: string; type: string; required?: boolean; note?: string }[])
      : [];
    return (
      <Card className="flex flex-col gap-3 p-4">
        <div>
          <div className="text-sm font-medium">
            {run.product.title} needs a few details
          </div>
          <p className="mt-1 text-[13px] text-ink-2">{run.message}</p>
        </div>
        <form action={provideInputs} className="flex flex-col gap-3">
          <input type="hidden" name="runId" value={run.id} />
          {schema.map((field) => (
            <label key={field.name} className="flex flex-col gap-1.5">
              <span className="text-[13px] font-medium">
                {field.label}
                {field.required !== false ? (
                  <span className="ml-1 font-normal text-ink-3">· required</span>
                ) : field.note ? (
                  <span className="ml-1 font-normal text-ink-3">· {field.note}</span>
                ) : null}
              </span>
              <Input
                name={field.name}
                type={field.type === "number" ? "number" : "text"}
                required={field.required !== false}
              />
            </label>
          ))}
          <Button type="submit" size="sm" className="self-start">
            Run with these
          </Button>
        </form>
        <Mono>
          run {run.runId} · nothing was spent
        </Mono>
      </Card>
    );
  }

  const failed = run.result === "ERROR" || run.result === "DENIED";

  return (
    <div className="flex flex-col gap-4">
      <Card className="flex flex-col gap-3 p-4">
        <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
          <span className="text-xs text-ink-3">Matched from your workspace</span>
          <span className="text-sm font-medium">{run.product.title}</span>
          <span className="text-xs text-ink-3">
            · {run.product.kind === "AGENT" ? "Agent" : "Workflow"} · v
            {run.productVersion}
          </span>
          <Badge tone={failed ? "blocked" : "ready"}>
            {failed ? "Failed" : "Ready"}
          </Badge>
          <a href={`/marketplace/${run.product.slug}`} className="ml-auto text-[13px]">
            Change product
          </a>
        </div>

        <div className="border-t border-selected pt-3">
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <span className="text-[13px] font-medium">
              {isRunning
                ? `Running · step ${done + 1} of ${run.steps.length}`
                : run.result === "PARTIAL"
                  ? "Partial success"
                  : run.result === "STOPPED"
                    ? `Stopped · ${run.errorType}`
                    : failed
                      ? `Failed · ${run.errorType ?? "error"}`
                      : "Done"}
            </span>
            <Mono>
              started {formatDate(run.startedAt)} · {formatDuration(run.durationMs)}
            </Mono>
          </div>

          <ul className="mt-3 flex flex-col gap-2">
            {run.steps.map((step) => (
              <li key={step.idx} className="flex items-center gap-2.5 text-[13px]">
                <span className={`size-1.5 flex-none rounded-full ${stepDot[step.status]}`} />
                <span
                  className={
                    step.status === "QUEUED" || step.status === "SKIPPED"
                      ? "text-ink-3"
                      : "text-ink"
                  }
                >
                  {step.label}
                </span>
                {/* Synthesised steps carry no timing of their own; an empty
                    column is more honest than a row of dashes. */}
                <span className="ml-auto font-mono text-xs text-ink-3">
                  {step.status === "QUEUED"
                    ? "queued"
                    : step.status === "RUNNING"
                      ? "running"
                      : step.durationMs !== null
                        ? formatDuration(step.durationMs)
                        : ""}
                </span>
              </li>
            ))}
          </ul>

          {isRunning ? (
            <div className="mt-3 flex items-center justify-between gap-3 border-t border-dashed border-selected pt-3">
              <span className="text-xs text-ink-3">
                We&apos;ll notify you when it finishes. Safe to close.
              </span>
              <Button tone="secondary" size="sm">
                Cancel run
              </Button>
            </div>
          ) : null}
        </div>
      </Card>

      {run.artifacts.map((artifact) => (
        <Card key={artifact.id} className="flex flex-col gap-3 p-4">
          <div className="flex flex-wrap items-center gap-3">
            <span className="flex size-10 flex-none items-center justify-center rounded-row bg-ready-tint font-mono text-[10px] font-semibold text-ready-ink">
              {artifact.mimeType.includes("spreadsheet") ? (
                <FileSpreadsheet size={18} strokeWidth={1.8} />
              ) : (
                extension(artifact.name)
              )}
            </span>
            <div className="min-w-0 flex-1">
              <div className="text-sm font-medium">Result · saved</div>
              <div className="mt-0.5 truncate text-xs text-ink-3">
                {artifact.name} · {formatBytes(artifact.sizeBytes)} · Platform
                storage
                {artifact.deliveredTo.length > 0
                  ? ` · copy delivered to ${artifact.deliveredTo.join(", ")}`
                  : ""}
              </div>
            </div>
            <div className="flex gap-2">
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
            </div>
          </div>
          <div className="border-t border-dashed border-selected pt-2.5">
            <Mono className="text-[11.5px] text-ink-3">
              From {run.product.title} v{run.productVersion} · run {run.runId} ·{" "}
              {formatDate(run.startedAt)} · kept for {artifact.keepDays} days
            </Mono>
          </div>
        </Card>
      ))}
    </div>
  );
}
