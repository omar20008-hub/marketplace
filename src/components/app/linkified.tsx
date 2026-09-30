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
