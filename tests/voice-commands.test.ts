import { describe, expect, it } from "vitest";
import { appendTranscript, clock, IDLE, noticeFor, parseVoiceCommand, voiceReducer } from "@/components/app/voice";

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
  it("starts listening from idle and counts seconds", () => {
    let state = voiceReducer(IDLE, { type: "start" });
    expect(state).toEqual({ phase: "listening", seconds: 0 });
    state = voiceReducer(state, { type: "tick" });
    state = voiceReducer(state, { type: "tick" });
    expect(state).toEqual({ phase: "listening", seconds: 2 });
  });

  it("ignores a second start while already listening", () => {
    const listening = { phase: "listening" as const, seconds: 5 };
    expect(voiceReducer(listening, { type: "start" })).toBe(listening);
  });

  it("returns to idle and keeps the reason it stopped", () => {
    const state = voiceReducer({ phase: "listening", seconds: 3 }, { type: "stopped", notice: "No microphone was found." });
    expect(state).toEqual({ phase: "idle", notice: "No microphone was found." });
  });

  it("does not count time while idle", () => {
    expect(voiceReducer(IDLE, { type: "tick" })).toBe(IDLE);
  });
});

describe("noticeFor and clock", () => {
  it("says nothing when the person cancelled", () => {
    expect(noticeFor("aborted")).toBeUndefined();
  });

  it("says what to do when the microphone is blocked", () => {
    expect(noticeFor("not-allowed")).toMatch(/blocked/);
  });

  it("formats seconds as m:ss", () => {
    expect(clock(2)).toBe("0:02");
    expect(clock(75)).toBe("1:15");
  });
});
