import { describe, expect, it } from "vitest";
import { appendTranscript, parseVoiceCommand } from "@/components/app/voice";

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
