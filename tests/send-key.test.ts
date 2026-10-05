import { describe, expect, it } from "vitest";
import { isSendKey } from "@/components/app/send-key";

describe("isSendKey", () => {
  it("sends on Enter, however the driver reports it", () => {
    expect(isSendKey({ key: "Enter", shiftKey: false })).toBe(true);
    expect(isSendKey({ key: "Unidentified", code: "Enter", shiftKey: false })).toBe(true);
    expect(isSendKey({ key: "", code: "NumpadEnter", shiftKey: false })).toBe(true);
    expect(isSendKey({ key: "", keyCode: 13, shiftKey: false })).toBe(true);
  });

  it("keeps Shift+Enter for a new line", () => {
    expect(isSendKey({ key: "Enter", shiftKey: true })).toBe(false);
  });

  it("leaves an input method that is still composing alone", () => {
    expect(isSendKey({ key: "Enter", shiftKey: false, nativeEvent: { isComposing: true } })).toBe(false);
  });

  it("ignores other keys", () => {
    expect(isSendKey({ key: "a", code: "KeyA", shiftKey: false })).toBe(false);
  });
});
