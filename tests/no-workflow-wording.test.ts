import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { mockDriver } from "@/lib/n8n/mock";

/**
 * Every product is an "agent" to a person. The word "workflow" stays in code
 * identifiers and comments, never in text a user, creator or admin reads.
 */

const root = join(__dirname, "..");

const FILES = [
  "src/app/(app)/creator/upload/upload-form.tsx",
  "src/app/(app)/creator/page.tsx",
  "src/app/(app)/marketplace/filters.tsx",
  "src/app/(app)/marketplace/page.tsx",
  "src/app/(app)/marketplace/[slug]/page.tsx",
  "src/app/(app)/workspace/page.tsx",
  "src/app/page.tsx",
  "src/app/(app)/admin/page.tsx",
  "src/app/login/page.tsx",
  "src/app/layout.tsx",
  "src/components/app/run-card.tsx",
  "src/components/app/product-glyph.tsx",
];

function withoutComments(source: string) {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, "")
    .split("\n")
    .map((line) => line.replace(/(^|\s)\/\/.*$/, "$1"))
    .join("\n");
}

describe("no user-visible 'workflow'", () => {
  it.each(FILES)("%s", (file) => {
    const source = withoutComments(readFileSync(join(root, file), "utf8"))
      // Permitted: an n8n URL path segment and code identifiers.
      .replace(/\/workflow\//g, "")
      .replace(/[A-Za-z0-9_]*[Ww]orkflow[A-Za-z0-9_]*/g, (word) =>
        word.toLowerCase() === "workflow" || word.toLowerCase() === "workflows"
          ? word
          : "",
      );

    expect(source.match(/\bworkflows?\b/i)).toBeNull();
  });

  it("the mock driver's refusal for a missing trigger does not say it", async () => {
    const reply = await mockDriver.upload({
      creatorId: "c1",
      title: "T",
      description: "D",
      actionType: "read",
      file: JSON.stringify({ nodes: [{ type: "n8n-nodes-base.webhook" }] }),
    });

    expect("errorText" in reply && reply.errorText).toBeTruthy();
    expect("errorText" in reply && reply.errorText).not.toMatch(/workflow/i);
  });
});
