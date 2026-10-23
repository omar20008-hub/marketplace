import { describe, expect, it } from "vitest";
import {
  appendTranscript,
  clock,
  concatSamples,
  downsample,
  encodeWav,
  IDLE,
  parseVoiceCommand,
  voiceReducer,
} from "@/components/app/voice";

/** What a spoken phrase means in the chat box, and how dictated words join the text. */

describe("parseVoiceCommand", () => {
  it.each(["أرسل", "ارسل.", "send", "Send it!"])("treats %s as send", (phrase) => {
    expect(parseVoiceCommand(phrase)).toEqual({ kind: "send" });
  });

  it.each(["امسح", "clear", "امسح الكل،"])("treats %s as clear", (phrase) => {
    expect(parseVoiceCommand(phrase)).toEqual({ kind: "clear" });
  });

  it("dictates a phrase that only starts with a command word", () => {
    expect(parseVoiceCommand("أرسل الملف إلى فلان")).toEqual({ kind: "text", text: "أرسل الملف إلى فلان" });
  });

  it("dictates ordinary speech as it was said", () => {
    expect(parseVoiceCommand("  ما أخبار الأسبوع؟ ")).toEqual({ kind: "text", text: "ما أخبار الأسبوع؟" });
  });
});

describe("appendTranscript", () => {
  it("uses the spoken words when the box is empty", () => {
    expect(appendTranscript("", "مرحبا")).toBe("مرحبا");
  });

  it("adds one space between what was typed and what was said", () => {
    expect(appendTranscript("أريد أن   ", "أعرف الطقس")).toBe("أريد أن أعرف الطقس");
  });

  it("leaves the text alone when nothing was heard", () => {
    expect(appendTranscript("نص", "   ")).toBe("نص");
  });
});

describe("voiceReducer", () => {
  it("starts recording from idle and counts seconds", () => {
    let state = voiceReducer(IDLE, { type: "start" });
    expect(state).toEqual({ phase: "listening", seconds: 0 });
    state = voiceReducer(state, { type: "tick" });
    state = voiceReducer(state, { type: "tick" });
    expect(state).toEqual({ phase: "listening", seconds: 2 });
  });

  it("waits for the text after the recording is sent, and stops counting", () => {
    const sent = voiceReducer({ phase: "listening", seconds: 4 }, { type: "sent" });
    expect(sent).toEqual({ phase: "transcribing" });
    expect(voiceReducer(sent, { type: "tick" })).toBe(sent);
    expect(voiceReducer(sent, { type: "start" })).toBe(sent);
  });

  it("returns to idle and keeps the reason it stopped", () => {
    const state = voiceReducer({ phase: "transcribing" }, { type: "stopped", notice: "Try again." });
    expect(state).toEqual({ phase: "idle", notice: "Try again." });
  });

  it("does not count time while idle", () => {
    expect(voiceReducer(IDLE, { type: "tick" })).toBe(IDLE);
  });
});

describe("clock", () => {
  it("formats seconds as m:ss", () => {
    expect(clock(2)).toBe("0:02");
    expect(clock(75)).toBe("1:15");
  });
});

describe("the WAV recording", () => {
  it("joins the captured chunks in order", () => {
    expect(Array.from(concatSamples([new Float32Array([1, 2]), new Float32Array([3])]))).toEqual([1, 2, 3]);
  });

  it("averages samples down to the lower rate", () => {
    const out = downsample(new Float32Array([0, 0.5, 1, 1, 0.2, 0.4]), 48_000, 16_000);
    expect(Array.from(out).map((v) => Number(v.toFixed(3)))).toEqual([0.5, 0.533]);
  });

  it("leaves samples alone when the rate is already low enough", () => {
    const samples = new Float32Array([0.1, 0.2]);
    expect(downsample(samples, 16_000, 16_000)).toBe(samples);
  });

  it("writes a 16-bit mono PCM header and clamps the samples", () => {
    const wav = encodeWav(new Float32Array([0, 1, -1, 2]), 16_000);
    const view = new DataView(wav);
    const text = (offset: number) => String.fromCharCode(...new Uint8Array(wav, offset, 4));
    expect(text(0)).toBe("RIFF");
    expect(text(8)).toBe("WAVE");
    expect(text(36)).toBe("data");
    expect(view.getUint16(22, true)).toBe(1);
    expect(view.getUint32(24, true)).toBe(16_000);
    expect(view.getUint16(34, true)).toBe(16);
    expect(view.getUint32(40, true)).toBe(8);
    expect([0, 1, 2, 3].map((i) => view.getInt16(44 + i * 2, true))).toEqual([0, 32767, -32768, 32767]);
  });
});
