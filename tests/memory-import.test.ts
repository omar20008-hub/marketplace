import { describe, expect, it } from "vitest";
import { IMPORT_PROMPT, cleanFact, parseMemoryImport } from "@/lib/memory-rules";

const EXPORT = `Here is everything I have.

\`\`\`
## Instructions
[2025-03-01] - Always answer in short bullet points.
[unknown] - Never use emojis.

## Identity
[2024-01-10] - My name is Sara.
[2024-06-02] - I live in Riyadh.

## Career
[2023-09-15] - I run a coffee shop called Bean & Co.

## Projects
[2025-05-20] - Bean & Co website: in progress, moving to a new host.

## Preferences
[2025-02-14] - I prefer concise answers.
\`\`\`

This is the complete set.`;

describe("parseMemoryImport", () => {
  it("files each entry under the file its category names, without the date", () => {
    const { facts, unplaced } = parseMemoryImport(EXPORT);
    // The intro sentence before the first category is counted, and the closing remark is not.
    expect(unplaced).toBe(1);
    expect(facts).toEqual([
      { file: "Instructions", text: "Always answer in short bullet points." },
      { file: "Instructions", text: "Never use emojis." },
      { file: "Profile", text: "My name is Sara." },
      { file: "Profile", text: "I live in Riyadh." },
      { file: "Work", text: "I run a coffee shop called Bean & Co." },
      { file: "Projects", text: "Bean & Co website: in progress, moving to a new host." },
      { file: "Preferences", text: "I prefer concise answers." },
    ]);
  });

  it("recognises the category headings an assistant writes in its own style", () => {
    const { facts } = parseMemoryImport(
      ["**Identity**", "[unknown] - Lives in Jeddah", "1. **Career**:", "- Works as a designer", "### Preferences", "- Likes tables"].join("\n"),
    );
    expect(facts.map((f) => f.file)).toEqual(["Profile", "Work", "Preferences"]);
    expect(facts.map((f) => f.text)).toEqual(["Lives in Jeddah", "Works as a designer", "Likes tables"]);
  });

  it("does not file a line under the category before it once another heading starts", () => {
    const { facts, unplaced } = parseMemoryImport("## Identity\n- Name is Omar\n## Notes about this export\n- Stray line");
    expect(facts).toEqual([{ file: "Profile", text: "Name is Omar" }]);
    expect(unplaced).toBe(1);
  });

  it("counts lines that sit under no category, and does not store the closing remark", () => {
    const { facts, unplaced } = parseMemoryImport("Here you go\n## Identity\n- Name is Omar\nThis is the complete set.");
    expect(facts).toEqual([{ file: "Profile", text: "Name is Omar" }]);
    expect(unplaced).toBe(1);
  });

  it("returns nothing for text with no category", () => {
    expect(parseMemoryImport("I have no memories about you.")).toEqual({ facts: [], unplaced: 1 });
    expect(parseMemoryImport("   \n  ")).toEqual({ facts: [], unplaced: 0 });
  });

  it("leaves a sensitive line in the parsed output, where the storage rules refuse it", () => {
    const { facts } = parseMemoryImport("## Identity\n- My email is sara@example.com\n- My password is hunter2");
    expect(facts).toHaveLength(2);
    for (const fact of facts) expect(cleanFact(fact.text)).toBeNull();
  });

  it("is the prompt a person copies, including the category list it relies on", () => {
    expect(IMPORT_PROMPT).toContain("Export all of my stored memories");
    for (const category of ["Instructions", "Identity", "Career", "Projects", "Preferences"]) {
      expect(IMPORT_PROMPT).toContain(category);
    }
  });
});
