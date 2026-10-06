import { describe, expect, it } from "vitest";
import { chunkText, storableText } from "@/lib/chunking";

describe("chunkText", () => {
  it("returns nothing for empty input", () => {
    expect(chunkText("  \n\n ")).toEqual([]);
  });

  it("keeps a short document whole", () => {
    expect(chunkText("One paragraph.\n\nAnother one.")).toEqual(["One paragraph.\n\nAnother one."]);
  });

  it("packs paragraphs up to the target and never exceeds it by much", () => {
    const text = Array.from({ length: 30 }, (_, i) => `Paragraph ${i} ${"word ".repeat(40)}`).join("\n\n");
    const chunks = chunkText(text, { target: 500, overlap: 60 });
    expect(chunks.length).toBeGreaterThan(3);
    for (const chunk of chunks) expect(chunk.length).toBeLessThanOrEqual(500 + 60 + 40);
  });

  it("overlaps consecutive chunks", () => {
    const text = Array.from({ length: 20 }, (_, i) => `Marker${i} ${"filler ".repeat(30)}`).join("\n\n");
    const chunks = chunkText(text, { target: 400, overlap: 100 });
    const secondStart = chunks[1].slice(0, 30);
    expect(chunks[0]).toContain(secondStart.split(/\s+/)[0]);
  });

  it("splits a single huge paragraph, even one with no spaces", () => {
    const chunks = chunkText("x".repeat(5000), { target: 1000, overlap: 0 });
    expect(chunks.length).toBe(5);
    expect(chunks.join("")).toBe("x".repeat(5000));
  });

  it("handles Arabic sentences", () => {
    const text = "هذه جملة أولى. ".repeat(200);
    const chunks = chunkText(text, { target: 300, overlap: 0 });
    expect(chunks.length).toBeGreaterThan(3);
  });
});

describe("storableText", () => {
  it("replaces NUL and other control characters but keeps newlines, returns and tabs", () => {
    expect(storableText("a\u0000b\u0001c\u007fd\ne\r\nf\tg")).toBe("a b c d\ne\r\nf\tg");
  });

  it("replaces a lone surrogate and keeps a proper pair", () => {
    expect(storableText("x\ud800y")).toBe("x\ufffdy");
    expect(storableText("x\udc00y")).toBe("x\ufffdy");
    expect(storableText("smile \ud83d\ude00!")).toBe("smile \ud83d\ude00!");
  });

  it("leaves ordinary text alone, Arabic included", () => {
    expect(storableText("مرحبا بالعالم. Hello.")).toBe("مرحبا بالعالم. Hello.");
  });
});

