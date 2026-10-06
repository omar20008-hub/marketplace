"use client";

import { useActionState, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { FileText, Loader2 } from "lucide-react";
import { Badge, Button } from "@/components/ds";
import { FolderPicker, type PickedFolder } from "@/components/app/folder-picker";
import {
  attachFolder,
  removeSource,
  retryFile,
  tryFileNow,
  syncNow,
  type KnowledgeActionState,
} from "@/server/knowledge/actions";

/** Re-reads the page every few seconds while files are still being processed. */
export function AutoRefresh({ active }: { active: boolean }) {
  const router = useRouter();
  useEffect(() => {
    if (!active) return;
    const timer = setInterval(() => router.refresh(), 4000);
    return () => clearInterval(timer);
  }, [active, router]);
  return null;
}

export function SourceStatus({
  status,
  busy,
  failed = 0,
}: {
  status: string;
  busy: boolean;
  failed?: number;
}) {
  if (status === "NEEDS_RECONNECT") return <Badge tone="blocked">Needs reconnect</Badge>;
  if (status === "PAUSED") return <Badge tone="neutral">Paused</Badge>;
  if (busy) {
    return (
      <Badge tone="partial">
        <Loader2 size={12} className="animate-spin" /> Syncing
      </Badge>
    );
  }
  // Nothing is in flight, but "up to date" is not the whole truth with files that failed.
  if (failed > 0) return <Badge tone="partial">{failed} failed</Badge>;
  return <Badge tone="ready">Up to date</Badge>;
}

const FILE_BADGE: Record<string, { tone: "ready" | "partial" | "blocked" | "neutral"; label: string }> = {
  READY: { tone: "ready", label: "Ready" },
  PENDING: { tone: "partial", label: "Waiting" },
  INDEXING: { tone: "partial", label: "Reading" },
  FAILED: { tone: "blocked", label: "Failed" },
  UNSUPPORTED: { tone: "neutral", label: "Skipped" },
};

export function FileRow({
  file,
}: {
  file: {
    id: string;
    name: string;
    path: string | null;
    url: string | null;
    status: string;
    error: string | null;
    chunks: number;
    /** When the queue will try a waiting file again, if it is backing off. */
    nextTry?: Date | null;
  };
}) {
  const badge = FILE_BADGE[file.status] ?? FILE_BADGE.UNSUPPORTED;
  return (
    <li className="flex flex-wrap items-center gap-3 border-b border-selected px-3 py-2.5 last:border-b-0">
      <FileText size={16} strokeWidth={1.8} className="flex-none text-ink-3" />
      <div className="min-w-0 flex-1">
        <div className="truncate text-sm">
          {file.url ? (
            <a href={file.url} target="_blank" rel="noreferrer noopener" className="hover:underline">
              {file.name}
            </a>
          ) : (
            file.name
          )}
        </div>
        {file.path || file.error ? (
          <div className="truncate text-xs text-ink-3">
            {file.error ?? file.path}
            {file.status === "PENDING" && file.error && file.nextTry ? ` ${nextTryText(file.nextTry)}` : ""}
          </div>
        ) : null}
      </div>
      {file.status === "PENDING" ? (
        <form action={tryFileNow}>
          <input type="hidden" name="fileId" value={file.id} />
          <Button type="submit" size="sm" tone="secondary">
            Try now
          </Button>
        </form>
      ) : null}
      {file.status === "FAILED" ? (
        <form action={retryFile}>
          <input type="hidden" name="fileId" value={file.id} />
          <Button type="submit" size="sm" tone="secondary">
            Retry
          </Button>
        </form>
      ) : null}
      <Badge tone={badge.tone}>{badge.label}</Badge>
    </li>
  );
}

function nextTryText(at: Date): string {
  const minutes = Math.ceil((at.getTime() - Date.now()) / 60_000);
  if (minutes <= 1) return "Next try within a minute.";
  if (minutes < 90) return `Next try in about ${minutes} minutes.`;
  return `Next try in about ${Math.round(minutes / 60)} hours.`;
}

export function SourceActions({
  sourceId,
  folderName,
  paused,
}: {
  sourceId: string;
  folderName: string;
  paused: boolean;
}) {
  const [confirming, setConfirming] = useState(false);
  return (
    <div className="flex flex-wrap items-center gap-2">
      {paused ? null : (
        <form action={syncNow}>
          <input type="hidden" name="sourceId" value={sourceId} />
          <Button type="submit" size="sm" tone="secondary">
            Check now
          </Button>
        </form>
      )}
      {confirming ? (
        <form action={removeSource} className="flex flex-wrap items-center gap-2">
          <input type="hidden" name="sourceId" value={sourceId} />
          <span className="text-[13px] text-ink-2">
            Stop using “{folderName}” and delete what was read from it?
          </span>
          <Button type="submit" size="sm">
            Remove
          </Button>
          <Button type="button" size="sm" tone="secondary" onClick={() => setConfirming(false)}>
            Keep
          </Button>
        </form>
      ) : (
        <Button type="button" size="sm" tone="secondary" onClick={() => setConfirming(true)}>
          Remove folder
        </Button>
      )}
    </div>
  );
}

export function AttachFolder({ installationId }: { installationId: string }) {
  const [folder, setFolder] = useState<PickedFolder | null>(null);
  const [state, action, pending] = useActionState<KnowledgeActionState, FormData>(attachFolder, {});
  return (
    <form action={action} className="flex flex-col gap-3">
      <input type="hidden" name="installationId" value={installationId} />
      <input type="hidden" name="folderId" value={folder?.id ?? ""} />
      <FolderPicker value={folder} onChange={setFolder} />
      {state.error ? <p className="text-[13px] text-danger-ink">{state.error}</p> : null}
      <div>
        <Button type="submit" size="sm" disabled={!folder || pending}>
          {pending ? "Connecting…" : "Use this folder"}
        </Button>
      </div>
    </form>
  );
}
