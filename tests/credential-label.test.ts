import { describe, expect, it } from "vitest";
import { credentialLabel } from "@/lib/credentials";

describe("credentialLabel", () => {
  it("names the Facebook token for what it connects, not for one product", () => {
    expect(credentialLabel("facebookGraphApi")).toBe("Facebook & Instagram");
  });

  it("falls back to the raw type for one it does not know", () => {
    expect(credentialLabel("somethingNew")).toBe("somethingNew");
    expect(credentialLabel("googlePalmApi")).toBe("Google Gemini");
  });
});
