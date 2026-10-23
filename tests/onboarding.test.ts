import { describe, expect, it } from "vitest";
import { whatsappChatUrl, whatsappLinkMessage } from "@/lib/onboarding";

/**
 * The WhatsApp link the welcome page opens: a chat with the business number,
 * "/link <code>" already typed, in exactly the form the n8n workflow reads.
 */
describe("whatsappChatUrl", () => {
  it("keeps only the digits of the business number", () => {
    expect(whatsappChatUrl("+966 50-000 0000")).toBe("https://wa.me/966500000000");
  });

  it("prefills the link message, encoded", () => {
    expect(whatsappChatUrl("966500000000", whatsappLinkMessage("ABCD2345"))).toBe(
      "https://wa.me/966500000000?text=%2Flink%20ABCD2345",
    );
  });

  it("gives nothing when no number is set", () => {
    expect(whatsappChatUrl(null)).toBeNull();
    expect(whatsappChatUrl("  ")).toBeNull();
  });
});
