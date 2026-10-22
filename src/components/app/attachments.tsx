"use client";

import { useRef, useState } from "react";
import { FileText, Loader2, Paperclip, X } from "lucide-react";

/** A saved file (its id), and for a JPEG or PNG also the public link a post can use. */
export type Uploaded = { id: string; name: string; url?: string; unreadable?: string };

/** What the picker offers. The server decides again from the bytes. */
const ACCEPT =
  ".pdf,.docx,.xlsx,.pptx,.txt,.md,.markdown,.json,.csv,.jpg,.jpeg,.png,.webp," +
  "application/pdf,text/plain,text/markdown,text/csv,application/json,image/jpeg,image/png,image/webp," +
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document," +
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet," +
  "application/vnd.openxmlformats-officedocument.presentationml.presentation";
const MAX_BYTES = 10 * 1024 * 1024;

const MAX = 4;

/**
 * Files attached to the message being written: documents, spreadsheets, slides,
 * text and images. Each is uploaded and read as soon as it is chosen (so Send never
 * waits on one), and the form then carries only the file ids (and an image's link),
 * which the server re-checks against the signed-in user before using any of them.
 */
export function useAttachments() {
  const [items, setItems] = useState<Uploaded[]>([]);
  const [busy, setBusy] = useState(0);
  const [error, setError] = useState("");

  async function add(files: FileList | null) {
    setError("");
    const chosen = [...(files ?? [])].slice(0, Math.max(0, MAX - items.length));
    if (files && files.length > chosen.length) setError(`You can attach up to ${MAX} files.`);
    for (const file of chosen) {
      if (file.size > MAX_BYTES) {
        setError(`${file.name} is larger than 10 MB.`);
        continue;
      }
      setBusy((n) => n + 1);
      try {
        const body = new FormData();
        body.set("file", file);
        const reply = await fetch("/api/files", { method: "POST", body });
        const json = (await reply.json().catch(() => ({}))) as {
          id?: string;
          name?: string;
          url?: string;
          error?: string | null;
          readable?: boolean;
        };
        if (!reply.ok || !json.id) throw new Error(json.error ?? "The upload failed.");
        setItems((current) => [
          ...current,
          {
            id: json.id!,
            name: json.name ?? file.name,
            url: json.url,
            unreadable: json.readable === false ? (json.error ?? "Its text could not be read.") : undefined,
          },
        ]);
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : "The upload failed.");
      } finally {
        setBusy((n) => n - 1);
      }
    }
  }

  return {
    items,
    uploading: busy > 0,
    error,
    add,
    remove: (id: string) => setItems((current) => current.filter((item) => item.id !== id)),
    clear: () => setItems([]),
  };
}

export type Attachments = ReturnType<typeof useAttachments>;

export function AttachButton({ attachments }: { attachments: Attachments }) {
  const input = useRef<HTMLInputElement>(null);
  return (
    <>
      <input
        ref={input}
        type="file"
        accept={ACCEPT}
        multiple
        hidden
        onChange={(event) => {
          void attachments.add(event.target.files);
          event.target.value = "";
        }}
      />
      <button
        type="button"
        aria-label="Attach a file"
        title="Attach a file: PDF, Word, Excel, PowerPoint, text, Markdown, JSON, CSV or an image"
        disabled={attachments.items.length >= MAX}
        onClick={() => input.current?.click()}
        className="flex size-[34px] flex-none items-center justify-center rounded-full border border-line text-ink-2 hover:bg-fill disabled:opacity-50"
      >
        {attachments.uploading ? (
          <Loader2 size={15} className="animate-spin" />
        ) : (
          <Paperclip size={15} strokeWidth={1.8} />
        )}
      </button>
    </>
  );
}

/** The chips under the text, the links the form submits, and any upload error. */
export function AttachmentList({ attachments }: { attachments: Attachments }) {
  return (
    <>
      {attachments.items.map((item) => (
        <input key={item.id} type="hidden" name="file" value={item.id} />
      ))}
      {attachments.items.map((item) =>
        item.url ? <input key={item.url} type="hidden" name="attachment" value={item.url} /> : null,
      )}
      {attachments.items.length > 0 || attachments.error ? (
        <div className="mt-2 flex flex-wrap items-center gap-2">
          {attachments.items.map((item) => (
            <span
              key={item.id}
              title={item.unreadable ? `Saved, but ${item.unreadable}` : undefined}
              className="flex max-w-[220px] items-center gap-2 rounded-full bg-fill py-1 pr-1.5 pl-1 text-xs text-ink-2"
            >
              {item.url ? (
                // eslint-disable-next-line @next/next/no-img-element -- a small preview of the user's own upload
                <img src={item.url} alt="" className="size-6 rounded-full object-cover" />
              ) : (
                <span className="flex size-6 items-center justify-center rounded-full bg-canvas">
                  <FileText size={13} />
                </span>
              )}
              <span className="truncate">{item.name}</span>
              <button
                type="button"
                aria-label={`Remove ${item.name}`}
                onClick={() => attachments.remove(item.id)}
                className="flex size-4 items-center justify-center rounded-full hover:bg-selected"
              >
                <X size={11} />
              </button>
            </span>
          ))}
          {attachments.error ? (
            <span role="alert" className="text-xs text-danger-ink">
              {attachments.error}
            </span>
          ) : null}
        </div>
      ) : null}
    </>
  );
}
