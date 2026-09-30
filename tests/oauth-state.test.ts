import { afterEach, describe, expect, it, vi } from "vitest";
import {
  OAUTH_STATE_TTL_SECONDS,
  cookieValue,
  newOAuthState,
  readOAuthState,
  safeReturnTo,
} from "@/lib/oauth-state";

/**
 * The state of a sign-in in flight. It is what stops a finished sign-in from
 * being replayed, forged, or completed in someone else's session.
 */

const input = { userId: "u1", verifier: "v", returnTo: "/marketplace/x/setup" };

afterEach(() => vi.useRealTimers());

describe("readOAuthState", () => {
  it("round-trips for the same user and nonce, carrying the verifier and the return path", () => {
    const { nonce, cookie } = newOAuthState(input);
    expect(readOAuthState(cookie, nonce, "u1")).toMatchObject({
      verifier: "v",
      returnTo: "/marketplace/x/setup",
    });
  });

  it("refuses a nonce that is not the one issued", () => {
    const { cookie } = newOAuthState(input);
    expect(readOAuthState(cookie, "another-nonce", "u1")).toBeNull();
  });

  it("refuses a different signed-in user", () => {
    const { nonce, cookie } = newOAuthState(input);
    expect(readOAuthState(cookie, nonce, "u2")).toBeNull();
  });

  it("refuses a tampered cookie", () => {
    const { nonce, cookie } = newOAuthState(input);
    const [body, signature] = cookie.split(".");
    const forged = Buffer.from(
      JSON.stringify({
        ...JSON.parse(Buffer.from(body, "base64url").toString()),
        returnTo: "https://evil.example",
        userId: "u2",
      }),
    ).toString("base64url");
    expect(readOAuthState(`${forged}.${signature}`, nonce, "u2")).toBeNull();
  });

  it("refuses an expired one", () => {
    vi.useFakeTimers();
    const { nonce, cookie } = newOAuthState(input);
    vi.advanceTimersByTime((OAUTH_STATE_TTL_SECONDS + 1) * 1000);
    expect(readOAuthState(cookie, nonce, "u1")).toBeNull();
  });

  it("refuses absence", () => {
    expect(readOAuthState(undefined, "n", "u1")).toBeNull();
    expect(readOAuthState("a.b", null, "u1")).toBeNull();
  });
});

describe("safeReturnTo", () => {
  it.each([
    ["/accounts", "/accounts"],
    ["/marketplace/x/setup?a=1", "/marketplace/x/setup?a=1"],
    ["https://evil.example", "/accounts"],
    ["//evil.example", "/accounts"],
    ["/\\evil.example", "/accounts"],
    ["javascript:alert(1)", "/accounts"],
    ["", "/accounts"],
    [null, "/accounts"],
  ])("%s -> %s", (value, expected) => {
    expect(safeReturnTo(value)).toBe(expected);
  });
});

describe("cookieValue", () => {
  it("finds one cookie among several", () => {
    expect(cookieValue("a=1; g_oauth=abc.def; b=2", "g_oauth")).toBe("abc.def");
    expect(cookieValue("a=1", "g_oauth")).toBeUndefined();
    expect(cookieValue(null, "g_oauth")).toBeUndefined();
  });
});
