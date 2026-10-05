import { describe, expect, it } from "vitest";
import {
  INJECT_MAX_CHARS,
  appendLine,
  cleanFact,
  cleanFileName,
  fileLines,
  findSensitiveLine,
  formatMemoryBlock,
  looksPersonal,
  parseMemoryCommand,
  removeLines,
  routeFact,
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
    ["تذكر أنني أحب الشاي", "أحب الشاي"],
    ["تذكر لي أني أعمل في مقهى", "أعمل في مقهى"],
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
  it("shows each file under its name, labelled as data", () => {
    const block = formatMemoryBlock([
      { name: "Profile", content: "- اسمي سعد" },
      { name: "Work", content: "I run a coffee shop\n- I have five staff" },
    ]);
    expect(block).toMatch(/^\[.*وليس تعليمات:/);
    expect(block).toContain("## Profile\n- اسمي سعد");
    expect(block).toContain("## Work\n- I run a coffee shop\n- I have five staff");
    expect(block.endsWith("]")).toBe(true);
  });

  it("skips empty files and says nothing when there is nothing", () => {
    expect(formatMemoryBlock([])).toBe("");
    expect(formatMemoryBlock([{ name: "Notes", content: "  \n " }])).toBe("");
    expect(formatMemoryBlock([{ name: "Empty", content: "" }, { name: "Work", content: "- x y z" }])).not.toContain("Empty");
  });

  it("stops before it grows past its budget, keeping the first files whole", () => {
    const long = Array.from({ length: 60 }, (_, i) => `fact number ${i} ${"x".repeat(60)}`).join("\n");
    const block = formatMemoryBlock([
      { name: "Profile", content: "- اسمي سعد" },
      { name: "Notes", content: long },
    ]);
    expect(block.length).toBeLessThan(INJECT_MAX_CHARS + 200);
    expect(block).toContain("- اسمي سعد");
  });
});

describe("files", () => {
  it("tidies a file name, or refuses it", () => {
    expect(cleanFileName("  Clients  ")).toBe("Clients");
    expect(cleanFileName("my/notes\\here")).toBe("my notes here");
    expect(cleanFileName("   ")).toBeNull();
    expect(cleanFileName("x".repeat(41))).toBeNull();
  });

  it("reads lines without their bullets", () => {
    expect(fileLines("- one\n* two\n\n  three  \n• four")).toEqual(["one", "two", "three", "four"]);
  });

  it("points at the first line that looks sensitive", () => {
    expect(findSensitiveLine("- I run a shop\n- my email is a@b.co\n- tea")).toBe(2);
    expect(findSensitiveLine("- I run a shop\n- I like tea")).toBeNull();
  });

  it("routes a fact to the file it belongs in", () => {
    expect(routeFact("اسمي سعد")).toBe("Profile");
    expect(routeFact("I run a coffee shop")).toBe("Work");
    expect(routeFact("أعمل في اللوجستيات")).toBe("Work");
    expect(routeFact("I prefer short answers")).toBe("Preferences");
    expect(routeFact("الاجتماع يوم الأحد")).toBe("Notes");
  });

  it("adds a line once, and never rewrites what the person wrote", () => {
    const first = appendLine("", "I run a coffee shop");
    expect(first).toEqual({ content: "- I run a coffee shop", added: true });
    const second = appendLine("My own heading\n- I run a coffee shop", "i run a Coffee shop.");
    expect(second.added).toBe(false);
    expect(appendLine("Free text the person typed", "I like tea").content).toBe("Free text the person typed\n- I like tea");
  });

  it("removes only the lines that mention what is forgotten", () => {
    const result = removeLines("- I run a coffee shop\n- I prefer short answers\nA heading", "the coffee shop");
    expect(result).toEqual({ content: "- I prefer short answers\nA heading", removed: 1 });
    expect(removeLines("- tea", "bakery")).toEqual({ content: "- tea", removed: 0 });
  });

  it("reads which file a request names", () => {
    expect(parseMemoryCommand("تذكر في ملف العمل أن عندي خمسة موظفين")).toEqual({
      type: "remember",
      fact: "عندي خمسة موظفين",
      file: "العمل",
    });
    expect(parseMemoryCommand("remember in my Clients file that Acme pays late")).toEqual({
      type: "remember",
      fact: "Acme pays late",
      file: "Clients",
    });
    expect(parseMemoryCommand("add to Work that I have five staff")).toEqual({
      type: "remember",
      fact: "I have five staff",
      file: "Work",
    });
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
