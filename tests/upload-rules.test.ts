import { describe, expect, it } from "vitest";
import { prisma } from "@/lib/db";
import { loadUploadRules } from "@/server/upload-rules";

/** The policy rows the migration seeded, read back the way the upload check reads them. */

describe("loadUploadRules", () => {
  it("loads the seeded node whitelist, with its verdicts", async () => {
    const { nodeRules } = await loadUploadRules();

    expect(Object.keys(nodeRules).length).toBe(await prisma.nodeRule.count());
    expect(nodeRules["n8n-nodes-base.executeCommand"]).toBe("deny");
    expect(nodeRules["n8n-nodes-base.code"]).toBe("review");
    expect(nodeRules["n8n-nodes-base.googleDrive"]).toBe("transform");
  });

  it("loads the credential types with their durability, and an OAuth type as blocked", async () => {
    const { credRules } = await loadUploadRules();

    expect(credRules.googlePalmApi).toEqual({
      durability: "durable",
      registered: false,
      authFlow: "",
      flowReady: false,
      note: "مفتاح API",
    });
    expect(credRules.googleSheetsOAuth2Api.durability).toBe("blocked");
  });
});
