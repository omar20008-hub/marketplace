import { describe, expect, it } from "vitest";
import {
  decryptSecret,
  encryptSecret,
  openCredential,
  sealCredential,
} from "@/lib/secrets";

/**
 * The connect screen promises the user their keys are "stored in an encrypted
 * vault". These tests hold that promise to its two halves: a stolen row is not
 * a live credential, and an altered row fails loudly instead of reaching a
 * workflow as garbage.
 */

describe("encryptSecret / decryptSecret", () => {
  it("round-trips", () => {
    expect(decryptSecret(encryptSecret("hunter2"))).toBe("hunter2");
  });

  it("round-trips unicode and an empty string", () => {
    for (const plaintext of ["مفتاح سري", "🔑 key", ""]) {
      expect(decryptSecret(encryptSecret(plaintext))).toBe(plaintext);
    }
  });

  it("never stores the plaintext", () => {
    const stored = encryptSecret("xoxb-super-secret-token");
    expect(stored).not.toContain("xoxb");
    expect(stored).not.toContain("secret");
  });

  it("uses a fresh IV, so the same input does not produce the same ciphertext", () => {
    // Otherwise a dump would leak which users share a credential value.
    const a = encryptSecret("same");
    const b = encryptSecret("same");
    expect(a).not.toBe(b);
    expect(decryptSecret(a)).toBe(decryptSecret(b));
  });

  it("is tagged with its format version", () => {
    expect(encryptSecret("x").split(".")).toHaveLength(4);
    expect(encryptSecret("x").startsWith("v1.")).toBe(true);
  });
});

describe("a row that was tampered with", () => {
  /**
   * Flips one bit of a base64url field, at the byte level.
   *
   * Flipping a character instead would not be reliable: the last character of a
   * base64url string can carry padding bits that decode to the same bytes, so
   * the "altered" value would sometimes be the original.
   */
  function flipBit(base64url: string) {
    const bytes = Buffer.from(base64url, "base64url");
    bytes[0] ^= 0x01;
    return bytes.toString("base64url");
  }

  it("refuses an altered ciphertext rather than returning garbage", () => {
    const [version, iv, tag, ciphertext] = encryptSecret("original").split(".");

    expect(() =>
      decryptSecret([version, iv, tag, flipBit(ciphertext)].join(".")),
    ).toThrow();
  });

  it("refuses an altered auth tag", () => {
    const [version, iv, tag, ciphertext] = encryptSecret("original").split(".");

    expect(() =>
      decryptSecret([version, iv, flipBit(tag), ciphertext].join(".")),
    ).toThrow();
  });

  it("refuses an IV from a different record", () => {
    const [, otherIv] = encryptSecret("other").split(".");
    const [version, , tag, ciphertext] = encryptSecret("original").split(".");

    expect(() =>
      decryptSecret([version, otherIv, tag, ciphertext].join(".")),
    ).toThrow();
  });

  it("refuses a value that is not in the stored format at all", () => {
    for (const bad of ["", "plaintext", "v1.only.three"]) {
      expect(() => decryptSecret(bad)).toThrow(
        /not in the expected format|Unsupported secret format/,
      );
    }
  });

  it("names an unsupported format version", () => {
    const [, iv, tag, ciphertext] = encryptSecret("x").split(".");
    expect(() => decryptSecret(["v2", iv, tag, ciphertext].join("."))).toThrow(
      /Unsupported secret format: v2/,
    );
  });
});

describe("sealCredential / openCredential", () => {
  it("round-trips a credential's field map", () => {
    const values = { accessToken: "xoxb-123", teamId: "T1" };
    expect(openCredential(sealCredential(values))).toEqual(values);
  });

  it("treats a missing credential as an empty set, not an error", () => {
    // A connected account row with no secret yet must not crash a page that
    // reads it; it simply has nothing to inject.
    expect(openCredential(null)).toEqual({});
  });

  it("keeps each field's exact value, including one that looks like JSON", () => {
    const values = { config: '{"nested":true}', empty: "" };
    expect(openCredential(sealCredential(values))).toEqual(values);
  });
});
