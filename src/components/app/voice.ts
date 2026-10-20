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

/** What the recording bar shows: idle, or listening for a number of seconds. */
export type VoiceState =
  | { phase: "idle"; notice?: string }
  | { phase: "listening"; seconds: number };

export type VoiceAction =
  | { type: "start" }
  | { type: "tick" }
  | { type: "stopped"; notice?: string };

export const IDLE: VoiceState = { phase: "idle" };

export function voiceReducer(state: VoiceState, action: VoiceAction): VoiceState {
  switch (action.type) {
    case "start":
      return state.phase === "listening" ? state : { phase: "listening", seconds: 0 };
    case "tick":
      return state.phase === "listening" ? { phase: "listening", seconds: state.seconds + 1 } : state;
    case "stopped":
      return { phase: "idle", notice: action.notice };
  }
}

/** The words shown to the person when listening stops for a reason other than confirming. */
export function noticeFor(error: string): string | undefined {
  switch (error) {
    case "aborted":
      return undefined;
    case "not-allowed":
    case "service-not-allowed":
      return "Microphone access was blocked. Allow it in the site settings, then try again.";
    case "audio-capture":
      return "No microphone was found.";
    case "no-speech":
      return "Nothing was heard. Tap the microphone and try again.";
    case "network":
      return "Speech recognition could not reach its service.";
    default:
      return "Voice input stopped.";
  }
}

/** Formats a count of seconds as m:ss, the way the bar shows it. */
export function clock(seconds: number): string {
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}
