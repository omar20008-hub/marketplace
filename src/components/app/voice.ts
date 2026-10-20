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

/** What the recording bar shows: idle, recording for a number of seconds, or waiting for the text. */
export type VoiceState =
  | { phase: "idle"; notice?: string }
  | { phase: "listening"; seconds: number }
  | { phase: "transcribing" };

export type VoiceAction =
  | { type: "start" }
  | { type: "tick" }
  | { type: "sent" }
  | { type: "stopped"; notice?: string };

export const IDLE: VoiceState = { phase: "idle" };

/** Longest recording, in seconds. The bar confirms by itself when it is reached. */
export const MAX_RECORDING_SECONDS = 120;

export function voiceReducer(state: VoiceState, action: VoiceAction): VoiceState {
  switch (action.type) {
    case "start":
      return state.phase === "idle" ? { phase: "listening", seconds: 0 } : state;
    case "tick":
      return state.phase === "listening" ? { phase: "listening", seconds: state.seconds + 1 } : state;
    case "sent":
      return state.phase === "listening" ? { phase: "transcribing" } : state;
    case "stopped":
      return { phase: "idle", notice: action.notice };
  }
}

/** Formats a count of seconds as m:ss, the way the bar shows it. */
export function clock(seconds: number): string {
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}

/**
 * Recordings are sent as 16 kHz mono WAV: every browser can make it from the
 * microphone, and every speech model reads it, which is not true of WebM.
 */
export const WAV_SAMPLE_RATE = 16_000;

export function concatSamples(chunks: Float32Array[]): Float32Array {
  const out = new Float32Array(chunks.reduce((total, chunk) => total + chunk.length, 0));
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
}

/** Averages each run of input samples into one output sample. */
export function downsample(samples: Float32Array, fromRate: number, toRate: number): Float32Array {
  if (toRate >= fromRate) return samples;
  const ratio = fromRate / toRate;
  const out = new Float32Array(Math.floor(samples.length / ratio));
  for (let i = 0; i < out.length; i++) {
    const from = Math.floor(i * ratio);
    const to = Math.min(samples.length, Math.floor((i + 1) * ratio));
    let sum = 0;
    for (let j = from; j < to; j++) sum += samples[j];
    out[i] = to > from ? sum / (to - from) : 0;
  }
  return out;
}

/** 16-bit PCM, one channel, with the 44-byte WAV header. */
export function encodeWav(samples: Float32Array, sampleRate: number): ArrayBuffer {
  const buffer = new ArrayBuffer(44 + samples.length * 2);
  const view = new DataView(buffer);
  const write = (offset: number, text: string) => {
    for (let i = 0; i < text.length; i++) view.setUint8(offset + i, text.charCodeAt(i));
  };
  write(0, "RIFF");
  view.setUint32(4, 36 + samples.length * 2, true);
  write(8, "WAVE");
  write(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  write(36, "data");
  view.setUint32(40, samples.length * 2, true);
  for (let i = 0; i < samples.length; i++) {
    const clamped = Math.max(-1, Math.min(1, samples[i]));
    view.setInt16(44 + i * 2, clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff, true);
  }
  return buffer;
}
