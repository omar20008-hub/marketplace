/**
 * What a spoken phrase means in the chat box. A phrase is a command only when the
 * whole phrase is the command, so "أرسل الملف إلى فلان" is dictated, not sent.
 */

export type VoiceCommand = { kind: "send" } | { kind: "clear" } | { kind: "text"; text: string };

const SEND = new Set(["أرسل", "ارسل", "send", "send it"]);
const CLEAR = new Set(["امسح", "امسح الكل", "clear", "clear it"]);

export function parseVoiceCommand(spoken: string): VoiceCommand {
  const phrase = spoken.trim();
  const key = phrase.replace(/[.!?؟،,]+$/u, "").trim().toLowerCase();
  if (SEND.has(key)) return { kind: "send" };
  if (CLEAR.has(key)) return { kind: "clear" };
  return { kind: "text", text: phrase };
}

/** Adds dictated words after what is already typed, with one space between. */
export function appendTranscript(current: string, spoken: string): string {
  const added = spoken.trim();
  if (!added) return current;
  if (!current.trim()) return added;
  return `${current.replace(/\s+$/u, "")} ${added}`;
}
