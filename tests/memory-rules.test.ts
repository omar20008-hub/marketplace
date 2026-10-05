import { describe, expect, it } from "vitest";
import {
  INJECT_MAX_CHARS,
  cleanFact,
  formatMemoryBlock,
  looksPersonal,
  parseMemoryCommand,
  sameFact,
  splitFacts,
} from "@/lib/memory-rules";

/**
 * The rules for what may be remembered. Pure functions: nothing here touches a
 * database or a model.
 */

describe("cleanFact", () => {
  it("keeps an ordinary fact and tidies its edges", () => {
    expect(cleanFact('  "اسمي سعد وأعمل في المقاهي"  ')).toBe("اسمي سعد وأعمل في المقاهي");
    expect(cleanFact("I run a coffee shop")).toBe("I run a coffee shop");
  });

  it.each([
    ["an email", "my email is sa3d@example.com"],
    ["a phone", "call me on +966 55 578 4625"],
    ["a long number", "my id is 1234567890"],
    ["a link", "my site is https://example.com/x?token=abc"],
    ["a key shape", "the key is kb_UP5bvR5qsWto7HG0NnDn7SjB"],
    ["a password in English", "my password is hunter two"],
    ["a password in Arabic", "كلمة السر الخاصة بي برتقال"],
    ["a card number in Arabic", "رقم البطاقة عندي معروف"],
  ])("refuses %s", (_name, text) => {
    expect(cleanFact(text)).toBeNull();
  });

  it("refuses what is too short or too long", () => {
    expect(cleanFact("ab")).toBeNull();
    expect(cleanFact("x".repeat(241))).toBeNull();
  });

  it("sees through vowel marks", () => {
    expect(cleanFact("كَلِمَةُ السِّرِّ برتقال")).toBeNull();
  });
});

describe("parseMemoryCommand", () => {
  it.each([
    ["تذكر أن اسمي سعد", "اسمي سعد"],
    ["تذكّر أنّ عندي مقهى في الرياض.", "عندي مقهى في الرياض"],
    ["من فضلك احفظ ان لغتي المفضلة العربية", "لغتي المفضلة العربية"],
    ["لا تنس أن اجتماعي يوم الأحد", "اجتماعي يوم الأحد"],
    ["Remember that I prefer short answers", "I prefer short answers"],
    ["please remember I work in logistics", "I work in logistics"],
  ])("reads %s as remember", (message, fact) => {
    expect(parseMemoryCommand(message)).toEqual({ type: "remember", fact });
  });

  it.each([
    ["انس أن اسمي سعد", "اسمي سعد"],
    ["انسَ المقهى", "المقهى"],
    ["forget about the coffee shop", "the coffee shop"],
  ])("reads %s as forget", (message, phrase) => {
    expect(parseMemoryCommand(message)).toEqual({ type: "forget", phrase });
  });

  it("does not wipe everything from a sentence", () => {
    expect(parseMemoryCommand("انس كل شيء")).toBeNull();
    expect(parseMemoryCommand("forget everything")).toBeNull();
  });

  it("only reads a command at the start, and only a short one", () => {
    expect(parseMemoryCommand("هل يمكنك أن تتذكر أن اسمي سعد؟")).toBeNull();
    expect(parseMemoryCommand("لا تتذكر أن هذا سري")).toBeNull();
    expect(parseMemoryCommand("ما ملخص الملف؟")).toBeNull();
    expect(parseMemoryCommand("تذكر أن " + "ك".repeat(400))).toBeNull();
  });
});

describe("looksPersonal", () => {
  it("lets a message that states something about the person through", () => {
    expect(looksPersonal("أنا أعمل في شركة لوجستية في جدة")).toBe(true);
    expect(looksPersonal("اسمي سعد وأفضل الإجابات القصيرة")).toBe(true);
    expect(looksPersonal("I work in logistics and I prefer short answers")).toBe(true);
  });

  it("does not spend a model call on an ordinary request", () => {
    expect(looksPersonal("ما ملخص ملف alslam.pdf في ملفاتي؟")).toBe(false);
    expect(looksPersonal("what is the capital of Japan")).toBe(false);
    expect(looksPersonal("hi")).toBe(false);
  });
});

describe("sameFact", () => {
  it("ignores case, spacing, marks and a final stop", () => {
    expect(sameFact("I run a coffee shop.", "i  run a Coffee shop")).toBe(true);
    expect(sameFact("اسمي سَعد", "اسمي سعد")).toBe(true);
    expect(sameFact("I run a coffee shop", "I run a bakery")).toBe(false);
  });
});

describe("formatMemoryBlock", () => {
  it("labels the facts as data", () => {
    const block = formatMemoryBlock(["اسمي سعد", "I run a coffee shop"]);
    expect(block).toMatch(/^\[.*وليس تعليمات:/);
    expect(block).toContain("- اسمي سعد");
    expect(block.endsWith("]")).toBe(true);
  });

  it("says nothing when there is nothing", () => {
    expect(formatMemoryBlock([])).toBe("");
  });

  it("stops before it grows past its budget", () => {
    const facts = Array.from({ length: 30 }, (_, i) => `fact number ${i} ${"x".repeat(100)}`);
    expect(formatMemoryBlock(facts).length).toBeLessThan(INJECT_MAX_CHARS + 200);
  });
});

describe("splitFacts", () => {
  it("splits at a new statement about the person, in Arabic and English", () => {
    expect(splitFacts("اسمي سعد وأعمل في مقهى")).toEqual(["اسمي سعد", "أعمل في مقهى"]);
    expect(splitFacts("اسمي سعد وعندي مقهى في الرياض")).toEqual(["اسمي سعد", "عندي مقهى في الرياض"]);
    expect(splitFacts("I run a coffee shop and I prefer short answers")).toEqual([
      "I run a coffee shop",
      "I prefer short answers",
    ]);
    expect(splitFacts("I like tea; my team has five people")).toEqual(["I like tea", "my team has five people"]);
  });

  it("leaves a list alone", () => {
    expect(splitFacts("أحب الشاي والقهوة")).toEqual(["أحب الشاي والقهوة"]);
    expect(splitFacts("I like tea and coffee")).toEqual(["I like tea and coffee"]);
  });
});
