import { describe, expect, it } from "vitest";
import { looksUnreadable } from "@/lib/text-quality";

const repeat = (s: string, n: number) => Array.from({ length: n }, () => s).join(" ");

describe("looksUnreadable", () => {
  it("accepts ordinary text in several scripts", () => {
    expect(looksUnreadable(repeat("هذا نص عربي عادي عن عقد الإيجار والمدفوعات الشهرية.", 30))).toBe(false);
    expect(looksUnreadable(repeat("Payment terms are net thirty days from the invoice date.", 30))).toBe(false);
    expect(looksUnreadable(repeat("Les conditions de paiement sont à trente jours, déjà convenues.", 30))).toBe(false);
    expect(looksUnreadable(repeat("支付条款为发票日期起三十天内付款。", 30))).toBe(false);
    expect(looksUnreadable(repeat("const x = a + b; // total = 12% * (y - z)", 30))).toBe(false);
  });

  it("flags text that is mostly NUL, replacement characters or private-use code points", () => {
    expect(looksUnreadable(repeat("\u0000\u0000a\u0000\u0000b\u0000", 80))).toBe(true);
    expect(looksUnreadable(repeat("��x�", 120))).toBe(true);
    expect(looksUnreadable(repeat(" ok", 100))).toBe(true);
  });

  it("does not mistake emoji or symbols for garbage", () => {
    expect(looksUnreadable(repeat("📍 ☎️ ✨ ★ ♞ ✂ w", 100))).toBe(false);
  });

  it("tolerates a few stray symbols and short samples", () => {
    expect(looksUnreadable(repeat("Normal text here, with one © and a ™ now and then.", 30))).toBe(false);
    expect(looksUnreadable("\u0000\u0000\u0000")).toBe(false); // too short to judge
  });
});
