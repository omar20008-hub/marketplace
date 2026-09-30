"use client";

import { useCallback, useEffect, useState } from "react";
import { ChevronRight, Folder, Loader2 } from "lucide-react";
import { Button, Input } from "@/components/ds";

export type PickedFolder = { id: string; name: string };
type Crumb = { id: string; name: string };

const ROOT: Crumb = { id: "root", name: "My Drive" };
const SHARED: Crumb = { id: "shared", name: "Shared with me" };

const MESSAGES: Record<string, string> = {
  not_connected: "Connect your Google Drive first.",
  not_a_folder: "That is not a folder this Google account can open.",
  bad_parent: "That folder could not be opened.",
  drive_unavailable: "Google Drive could not be reached. Try again in a moment.",
};

/**
 * Browse the user's Drive folders and pick one. The listing comes from our own
 * server (which holds the Drive connection), so the browser never has a token
 * that could read a file — it only ever sees folder names.
 *
 * Choosing is explicit, on a button beside a folder, and separate from opening
 * it: clicking a name goes inside, so a folder is never picked by accident on
 * the way to the one below it. My Drive and Shared with me themselves cannot be
 * picked, since indexing a whole drive is never what anyone means.
 */
export function FolderPicker({
  value,
  onChange,
}: {
  value: PickedFolder | null;
  onChange: (folder: PickedFolder) => void;
}) {
  const [trail, setTrail] = useState<Crumb[]>([ROOT]);
  const [folders, setFolders] = useState<PickedFolder[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [link, setLink] = useState("");
  const [resolving, setResolving] = useState(false);

  const current = trail[trail.length - 1];

  useEffect(() => {
    let cancelled = false;
    // Deferred a tick so the loading state is set from a callback, not from the
    // effect body itself.
    const start = setTimeout(async () => {
      setFolders(null);
      setError(null);
      try {
        const response = await fetch(
          `/api/knowledge/folders?parent=${encodeURIComponent(current.id)}`,
        );
        const body = (await response.json()) as { folders?: PickedFolder[]; error?: string };
        if (cancelled) return;
        if (!response.ok) setError(MESSAGES[body.error ?? ""] ?? MESSAGES.drive_unavailable);
        else setFolders(body.folders ?? []);
      } catch {
        if (!cancelled) setError(MESSAGES.drive_unavailable);
      }
    }, 0);
    return () => {
      cancelled = true;
      clearTimeout(start);
    };
  }, [current.id]);

  const resolveLink = useCallback(async () => {
    if (!link.trim()) return;
    setResolving(true);
    setError(null);
    try {
      const response = await fetch(`/api/knowledge/folders?resolve=${encodeURIComponent(link)}`);
      const body = (await response.json()) as { folder?: PickedFolder; error?: string };
      if (response.ok && body.folder) {
        onChange(body.folder);
        setLink("");
      } else {
        setError(MESSAGES[body.error ?? ""] ?? MESSAGES.drive_unavailable);
      }
    } catch {
      setError(MESSAGES.drive_unavailable);
    } finally {
      setResolving(false);
    }
  }, [link, onChange]);

  return (
    <div className="flex flex-col gap-3">
      {value ? (
        <p className="flex items-center gap-2 rounded-row bg-ready-tint px-3 py-2 text-[13px] text-ready-ink">
          <Folder size={15} strokeWidth={1.8} />
          <span className="min-w-0 flex-1 truncate">
            Selected: <span className="font-medium">{value.name}</span>
          </span>
        </p>
      ) : null}

      <nav aria-label="Folder path" className="flex flex-wrap items-center gap-1 text-[13px]">
        {trail.map((crumb, index) => (
          <span key={crumb.id} className="flex items-center gap-1">
            {index > 0 ? <ChevronRight size={13} className="text-ink-3" /> : null}
            <button
              type="button"
              disabled={index === trail.length - 1}
              onClick={() => setTrail(trail.slice(0, index + 1))}
              className={
                index === trail.length - 1
                  ? "font-medium text-ink"
                  : "text-ink-2 underline-offset-2 hover:underline"
              }
            >
              {crumb.name}
            </button>
          </span>
        ))}
      </nav>

      <div className="max-h-64 overflow-y-auto rounded-card border border-selected">
        {error ? (
          <p role="alert" className="p-3 text-[13px] text-danger-ink">
            {error}
          </p>
        ) : folders === null ? (
          <p className="flex items-center gap-2 p-3 text-[13px] text-ink-3">
            <Loader2 size={14} className="animate-spin" /> Loading folders…
          </p>
        ) : (
          <ul>
            {current.id === "root" ? (
              <li className="border-b border-selected last:border-b-0">
                <button
                  type="button"
                  onClick={() => setTrail([ROOT, SHARED])}
                  className="flex w-full items-center gap-2 px-3 py-2.5 text-left text-sm hover:bg-fill"
                >
                  <Folder size={16} strokeWidth={1.8} className="text-ink-3" />
                  <span className="flex-1">Shared with me</span>
                  <ChevronRight size={14} className="text-ink-3" />
                </button>
              </li>
            ) : null}
            {folders.length === 0 && current.id !== "root" ? (
              <li className="p-3 text-[13px] text-ink-3">No folders here.</li>
            ) : null}
            {folders.map((folder) => (
              <li
                key={folder.id}
                className="flex items-center gap-2 border-b border-selected px-3 py-1.5 last:border-b-0"
              >
                <button
                  type="button"
                  onClick={() => setTrail([...trail, folder])}
                  className="flex min-w-0 flex-1 items-center gap-2 py-1 text-left text-sm hover:text-ink"
                >
                  <Folder size={16} strokeWidth={1.8} className="flex-none text-ink-3" />
                  <span className="truncate">{folder.name}</span>
                </button>
                <Button
                  type="button"
                  size="sm"
                  tone={value?.id === folder.id ? "primary" : "secondary"}
                  onClick={() => onChange(folder)}
                >
                  {value?.id === folder.id ? "Selected" : "Select"}
                </Button>
              </li>
            ))}
          </ul>
        )}
      </div>

      <div className="flex items-center gap-2">
        <Input
          value={link}
          onChange={(event) => setLink(event.target.value)}
          onKeyDown={(event) => {
            // Enter inside a wizard form would otherwise submit the whole form.
            if (event.key === "Enter") {
              event.preventDefault();
              void resolveLink();
            }
          }}
          placeholder="…or paste a folder link"
          aria-label="Folder link"
        />
        <Button type="button" size="sm" tone="secondary" className="flex-none whitespace-nowrap" disabled={resolving || !link.trim()} onClick={resolveLink}>
          Use link
        </Button>
      </div>
    </div>
  );
}
