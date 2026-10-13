import type { ReactNode } from "react";

/**
 * Message text with its links made clickable: `[label](https://…)` and bare
 * http(s) URLs. Nothing else is interpreted, and nothing is injected as HTML —
 * the pieces are React nodes, so a message can add a link but not markup, and
 * only to an http(s) address (never a javascript: one).
 */

const LINK = /\[([^\]\n]{1,200})\]\((https?:\/\/[^\s)]+)\)|(https?:\/\/[^\s<>()]+[^\s<>().,;:!?'"])/g;

export function linkify(text: string): ReactNode[] {
  const out: ReactNode[] = [];
  let last = 0;
  for (const match of text.matchAll(LINK)) {
    const at = match.index ?? 0;
    if (at > last) out.push(text.slice(last, at));
    const href = match[2] ?? match[3];
    out.push(
      <a
        key={at}
        href={href}
        target="_blank"
        rel="noreferrer noopener"
        className="underline underline-offset-2"
      >
        {match[1] ?? href}
      </a>,
    );
    last = at + match[0].length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

export function Linkified({ text }: { text: string }) {
  return <>{linkify(text)}</>;
}

/**
 * The stored pictures and clips a message points at: only links to this platform's
 * own media path, with an extension the platform actually serves. Anything else in
 * a message stays a plain link.
 */
const MEDIA = /https?:\/\/[^\s<>()'"]+?\/api\/media\/[A-Za-z0-9_-]{43}\.(jpg|png|mp4|webm)(?![A-Za-z0-9_.-])/g;

export type MediaPreview = { url: string; kind: "image" | "video" };

export function mediaPreviews(text: string): MediaPreview[] {
  const seen = new Set<string>();
  const out: MediaPreview[] = [];
  for (const match of text.matchAll(MEDIA)) {
    const url = match[0];
    if (seen.has(url)) continue;
    seen.add(url);
    out.push({ url, kind: match[1] === "mp4" || match[1] === "webm" ? "video" : "image" });
  }
  return out;
}

/** The pictures and clips a message carries, shown under its text. */
export function MediaPreviews({ text }: { text: string }) {
  const items = mediaPreviews(text);
  if (items.length === 0) return null;
  return (
    <div className="mt-3 flex flex-col gap-3">
      {items.map((item) =>
        item.kind === "video" ? (
          // A clip is shown with its own controls and never plays by itself.
          <video key={item.url} src={item.url} controls preload="metadata" className="max-h-[420px] w-full max-w-[560px] rounded-card" />
        ) : (
          // The platform serves these links itself, so there is no optimizer to hand them to.
          // eslint-disable-next-line @next/next/no-img-element
          <img
            key={item.url}
            src={item.url}
            alt=""
            loading="lazy"
            className="max-h-[420px] w-auto max-w-full rounded-card"
          />
        ),
      )}
    </div>
  );
}
