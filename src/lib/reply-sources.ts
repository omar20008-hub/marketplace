/**
 * Where an assistant reply says it got its information. The Orchestrator returns
 * plain text, so the sources are read from a trailing list under a "Sources:" (or
 * "المصادر:") heading. Pure: nothing here touches the stored message, the parsing
 * happens when a message is rendered.
 */

export type ReplySource =
  | { kind: "web"; name: string; url: string; iconUrl: string }
  | { kind: "file" | "agent" | "other"; name: string };

export type ParsedReply = {
  text: string;
  sources: ReplySource[];
  generalKnowledge: boolean;
};

const HEADING = /^\s*(?:#{1,6}\s*)?(?:\*\*|__)?\s*(?:sources?|المصادر|المصدر)\s*[:：]?\s*(?:\*\*|__)?\s*[:：]?\s*$/i;
const ITEM = /^\s*(?:[-*•]|\d+[.)])\s+(.+?)\s*$/;
const GENERAL_KNOWLEDGE = /^(?:general knowledge\s*,?\s*(?:without|no)\s+(?:a\s+)?search|معرفة عامة دون بحث)$/i;
const UNSAFE_SCHEME = /^(?:javascript|data|vbscript):|^file:\/\//i;

const isBlank = (line: string) => line.trim() === "";

/** A line reduced to its words: no list marker, emphasis, brackets or "Sources:" lead-in. */
function plainCore(line: string): string {
  return line
    .replace(/^\s*(?:[-*•]|\d+[.)])\s+/, "")
    .replace(/[*_()[\]]/g, "")
    .replace(/^\s*#*\s*(?:sources?|المصادر|المصدر)\s*[:：-]?\s*/i, "")
    .replace(/[.\s]+$/, "")
    .trim();
}

const isGeneralKnowledge = (line: string) => GENERAL_KNOWLEDGE.test(plainCore(line));

/** Only http(s) addresses; anything else is not a link. */
function safeUrl(raw: string): URL | null {
  try {
    const url = new URL(raw);
    return url.protocol === "http:" || url.protocol === "https:" ? url : null;
  } catch {
    return null;
  }
}

export function hostnameOf(url: URL): string {
  return url.hostname.replace(/^www\./i, "");
}

function webSource(rawUrl: string, label: string | undefined): ReplySource | null {
  const url = safeUrl(rawUrl);
  if (!url) return null;
  const cleaned = label?.replace(/[*_]/g, "").trim();
  // A label that is itself an address would put the full URL on screen.
  const name = cleaned && !/^(?:https?:\/\/|www\.)/i.test(cleaned) ? cleaned : hostnameOf(url);
  return { kind: "web", name, url: url.href, iconUrl: `${url.origin}/favicon.ico` };
}

function parseItem(raw: string): ReplySource | null {
  let text = raw.trim();
  if (UNSAFE_SCHEME.test(text.replace(/^[*_\s]+/, ""))) return null;

  const link = text.match(/\[([^\]\n]*)\]\(\s*([^)\s]+)\s*\)/);
  if (link) return webSource(link[2], link[1]);

  const bare = text.match(/https?:\/\/[^\s<>()]+[^\s<>().,;:!?'"*_]/i);
  if (bare) return webSource(bare[0], undefined);

  text = text.replace(/[*_]/g, "").trim();
  let kind: "file" | "agent" | "other" = "other";
  const prefixed = text.match(/^(file|ملف|agent|وكيل)\s*[:：]\s*(.*)$/i);
  if (prefixed) {
    kind = /^(file|ملف)$/i.test(prefixed[1]) ? "file" : "agent";
    text = prefixed[2].trim();
  }
  if (!text || UNSAFE_SCHEME.test(text)) return null;
  return { kind, name: text };
}

export function parseReplySources(body: string): ParsedReply {
  const lines = body.split("\n");
  const trimEnd = () => {
    while (lines.length > 0 && isBlank(lines[lines.length - 1])) lines.pop();
  };
  trimEnd();

  let generalKnowledge = false;
  while (lines.length > 0 && isGeneralKnowledge(lines[lines.length - 1])) {
    generalKnowledge = true;
    lines.pop();
    trimEnd();
  }
  // "Sources:" on its own line above the removed general-knowledge line.
  if (generalKnowledge && lines.length > 0 && HEADING.test(lines[lines.length - 1])) {
    lines.pop();
    trimEnd();
  }

  // A trailing list under a heading. Walk up over the items to find the heading.
  let i = lines.length - 1;
  const itemLines: string[] = [];
  while (i >= 0) {
    if (isBlank(lines[i])) {
      i--;
      continue;
    }
    const item = lines[i].match(ITEM);
    if (!item) break;
    itemLines.unshift(item[1]);
    i--;
  }

  const sources: ReplySource[] = [];
  let hadBlock = false;
  if (itemLines.length > 0 && i >= 0 && HEADING.test(lines[i])) {
    hadBlock = true;
    lines.length = i;
    trimEnd();
    const seen = new Set<string>();
    for (const raw of itemLines) {
      if (isGeneralKnowledge(raw)) {
        generalKnowledge = true;
        continue;
      }
      const source = parseItem(raw);
      if (!source) continue;
      const key = source.kind === "web" ? source.url : `${source.kind}:${source.name}`;
      if (seen.has(key)) continue;
      seen.add(key);
      sources.push(source);
    }
  }

  // Nothing recognised: the body is returned exactly as stored.
  const text = generalKnowledge || hadBlock ? lines.join("\n") : body;
  return { text, sources, generalKnowledge };
}
