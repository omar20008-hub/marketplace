import { describe, expect, it } from "vitest";
import { platformSideConnections } from "@/lib/credentials";

describe("platformSideConnections", () => {
  it("asks Ads Campaign for the Facebook connection, which never goes to n8n", () => {
    expect(platformSideConnections("tpl_ads_campaign_v1")).toEqual(["facebookGraphApi"]);
  });

  it("asks nothing of other products", () => {
    expect(platformSideConnections("tpl_other")).toEqual([]);
    expect(platformSideConnections(null)).toEqual([]);
  });
});
