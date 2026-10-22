"use client";

import { useEffect, useRef, useState } from "react";
import type { ReplySource } from "@/lib/reply-sources";

type WebSource = Extract<ReplySource, { kind: "web" }>;

const ROW_CAP = 5;

function Globe() {
  return (
    <svg viewBox="0 0 16 16" aria-hidden className="size-4 shrink-0 text-ink-3" fill="none" stroke="currentColor" strokeWidth="1.2">
      <circle cx="8" cy="8" r="6.5" />
      <path d="M1.5 8h13M8 1.5c2 2 2.8 4.2 2.8 6.5S10 12.5 8 14.5C6 12.5 5.2 10.3 5.2 8S6 3.5 8 1.5Z" />
    </svg>
  );
}

/** The cited site's own icon; without one (or when it fails to load) a globe, or nothing. */
function SiteIcon({ source, placeholder }: { source: WebSource; placeholder: boolean }) {
  const [failed, setFailed] = useState(false);
  if (failed) return placeholder ? <Globe /> : null;
  return (
    // The icon comes from the cited origin, so there is nothing for the optimizer to fetch.
    // eslint-disable-next-line @next/next/no-img-element
    <img
      src={source.iconUrl}
      alt=""
      width={16}
      height={16}
      loading="lazy"
      referrerPolicy="no-referrer"
      onError={() => setFailed(true)}
      className="size-4 shrink-0 rounded-sm"
    />
  );
}

function SiteLink({ source, placeholder }: { source: WebSource; placeholder: boolean }) {
  return (
    <a
      href={source.url}
      target="_blank"
      rel="noreferrer noopener"
      className="inline-flex items-center gap-1.5 underline underline-offset-2"
    >
      <SiteIcon source={source} placeholder={placeholder} />
      {source.name}
    </a>
  );
}

/** Where a reply got its information, shown under its text. */
export function ReplySources({ sources }: { sources: ReplySource[] }) {
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    const onDown = (event: MouseEvent) => {
      if (box.current && !box.current.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener("keydown", onKey);
    document.addEventListener("mousedown", onDown);
    return () => {
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("mousedown", onDown);
    };
  }, [open]);

  if (sources.length === 0) return null;

  if (sources.length === 1) {
    const only = sources[0];
    return (
      <div className="mt-3 text-[13px] text-ink-2">
        {only.kind === "web" ? <SiteLink source={only} placeholder={false} /> : only.name}
      </div>
    );
  }

  const web = sources.filter((s): s is WebSource => s.kind === "web");
  const shown = web.slice(0, ROW_CAP);
  const label = `${sources.length} sources`;

  return (
    <div ref={box} className="relative mt-3 inline-block text-[13px] text-ink-2">
      <button
        type="button"
        aria-label={label}
        aria-expanded={open}
        aria-haspopup="true"
        onClick={() => setOpen((v) => !v)}
        className="flex items-center gap-1.5 rounded-card border border-selected bg-fill px-2.5 py-1.5 hover:text-ink"
      >
        {shown.map((source) => (
          <SiteIcon key={source.url} source={source} placeholder />
        ))}
        {web.length > ROW_CAP ? <span aria-hidden>+{web.length - ROW_CAP}</span> : null}
        {web.length === 0 ? <span aria-hidden>{label}</span> : null}
      </button>
      {open ? (
        <ul className="absolute bottom-full left-0 z-10 mb-2 flex min-w-[220px] max-w-[320px] flex-col gap-2 rounded-card border border-selected bg-canvas p-3 shadow-lg">
          {sources.map((source) => (
            <li key={source.kind === "web" ? source.url : `${source.kind}:${source.name}`}>
              {source.kind === "web" ? <SiteLink source={source} placeholder /> : source.name}
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
