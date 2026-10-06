"use client";

import { useRef, useState } from "react";
import { Loader2, Paperclip, X } from "lucide-react";

export type Uploaded = { url: string; name: string };

const MAX = 4;

/**
 * Images attached to the message being written. Each file is uploaded as soon as it
 * is chosen (so Send never waits on one), and the form then carries only the links,
 * which the server re-checks against the signed-in user before using any of them.
 */
export function useAttachments() {
  const [items, setItems] = useState<Uploaded[]>([]);
  const [busy, setBusy] = useState(0);
  const [error, setError] = useState("");

  async function add(files: FileList | null) {
    setError("");
    const chosen = [...(files ?? [])].slice(0, Math.max(0, MAX - items.length));
    if (files && files.length > chosen.length) setError(`You can attach up to ${MAX} images.`);
    for (const file of chosen) {
      if (file.type !== "image/jpeg" && file.type !== "image/png") {
        setError("Only JPEG and PNG images can be attached.");
        continue;
      }
      setBusy((n) => n + 1);
      try {
        const body = new FormData();
        body.set("file", file);
        const reply = await fetch("/api/media", { method: "POST", body });
        const json = (await reply.json().catch(() => ({}))) as Partial<Uploaded> & { error?: string };
        if (!reply.ok || !json.url) throw new Error(json.error ?? "The upload failed.");
        setItems((current) => [...current, { url: json.url!, name: json.name ?? file.name }]);
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
    remove: (url: string) => setItems((current) => current.filter((item) => item.url !== url)),
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
        accept="image/jpeg,image/png"
        multiple
        hidden
        onChange={(event) => {
          void attachments.add(event.target.files);
          event.target.value = "";
        }}
      />
      <button
        type="button"
        aria-label="Attach an image"
        title="Attach a JPEG or PNG image"
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
        <input key={item.url} type="hidden" name="attachment" value={item.url} />
      ))}
      {attachments.items.length > 0 || attachments.error ? (
        <div className="mt-2 flex flex-wrap items-center gap-2">
          {attachments.items.map((item) => (
            <span
              key={item.url}
              className="flex max-w-[220px] items-center gap-2 rounded-full bg-fill py-1 pr-1.5 pl-1 text-xs text-ink-2"
            >
              {/* eslint-disable-next-line @next/next/no-img-element -- a small preview of the user's own upload */}
              <img src={item.url} alt="" className="size-6 rounded-full object-cover" />
              <span className="truncate">{item.name}</span>
              <button
                type="button"
                aria-label={`Remove ${item.name}`}
                onClick={() => attachments.remove(item.url)}
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
