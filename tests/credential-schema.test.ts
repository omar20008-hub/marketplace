import { describe, expect, it } from "vitest";
import { fallbackCredentialSchema, knownCredentialSchema } from "@/lib/credentials";

/**
 * The form a person fills in is built from a credential's schema. n8n's own
 * schema endpoint answers nothing for some types, and then the generic "apiKey"
 * form is shown, which n8n's create-credential call refuses for any type whose
 * one field is called something else.
 */
describe("credential forms", () => {
  it("asks for an access token for the Facebook connection, not a generic API key", () => {
    const schema = knownCredentialSchema("facebookGraphApi");
    expect(schema?.required).toEqual(["accessToken"]);
    expect(Object.keys(schema?.properties ?? {})).toEqual(["accessToken"]);
    expect(schema?.properties.accessToken).toMatchObject({ format: "password" });
  });

  it("still falls back to a generic API key for a type nobody has described", () => {
    expect(knownCredentialSchema("someOtherApi")).toBeNull();
    expect(fallbackCredentialSchema("someOtherApi")?.required).toEqual(["apiKey"]);
  });
});
