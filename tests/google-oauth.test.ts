import { afterEach, describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import {
  GoogleAuthError,
  appUrl,
  authorizationUrl,
  exchangeCode,
  identityFromIdToken,
  pkcePair,
  refreshAccessToken,
  revokeToken,
} from "@/lib/google-oauth";

/**
 * The Google half of connecting Drive. What matters most is what the
 * authorization request asks for — offline + consent is the difference between a
 * connection that lasts and one that cannot be renewed — and how a failure from
 * Google is classified, since only one kind of failure may disconnect a user.
 */

const CLIENT_ID = process.env.GOOGLE_CLIENT_ID!;

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function idToken(claims: Record<string, unknown>) {
  const payload = Buffer.from(JSON.stringify(claims)).toString("base64url");
  return `header.${payload}.signature`;
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("authorizationUrl", () => {
  it("asks for a renewable connection, with PKCE, and only the scopes it needs", () => {
    const { challenge } = pkcePair();
    const url = new URL(authorizationUrl({ state: "nonce-1", challenge }));
    const q = url.searchParams;

    expect(url.origin + url.pathname).toBe("https://accounts.google.com/o/oauth2/v2/auth");
    expect(q.get("client_id")).toBe(CLIENT_ID);
    expect(q.get("redirect_uri")).toBe(process.env.GOOGLE_REDIRECT_URI);
    expect(q.get("response_type")).toBe("code");
    expect(q.get("access_type")).toBe("offline");
    expect(q.get("prompt")).toBe("consent");
    expect(q.get("state")).toBe("nonce-1");
    expect(q.get("code_challenge")).toBe(challenge);
    expect(q.get("code_challenge_method")).toBe("S256");
    expect(q.get("scope")!.split(" ").sort()).toEqual(
      ["email", "https://www.googleapis.com/auth/drive.readonly", "openid"].sort(),
    );
  });
});

describe("pkcePair", () => {
  it("derives the challenge from the verifier, and is different every time", () => {
    const a = pkcePair();
    const b = pkcePair();
    expect(a.challenge).toBe(createHash("sha256").update(a.verifier).digest("base64url"));
    expect(a.verifier).not.toBe(b.verifier);
  });
});

describe("appUrl", () => {
  it("returns to the origin the redirect URI is registered on, not the request's", () => {
    const request = new Request("http://internal-host:8080/api/oauth/google/callback");
    expect(appUrl("/accounts", { connected: "x" }, request)).toBe(
      "https://app.example.test/accounts?connected=x",
    );
  });
});

describe("exchangeCode / refreshAccessToken", () => {
  it("maps a token response, and sends the PKCE verifier", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse({
        access_token: "ya29.a",
        refresh_token: "1//r",
        expires_in: 3600,
        scope: "openid email https://www.googleapis.com/auth/drive.readonly",
        id_token: "id",
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const tokens = await exchangeCode("the-code", "the-verifier");

    expect(tokens).toMatchObject({ accessToken: "ya29.a", refreshToken: "1//r", idToken: "id" });
    expect(tokens.scope).toContain("https://www.googleapis.com/auth/drive.readonly");
    expect(tokens.expiresAt.getTime()).toBeGreaterThan(Date.now() + 3_000_000);

    const body = new URLSearchParams(fetchMock.mock.calls[0][1].body as URLSearchParams);
    expect(body.get("grant_type")).toBe("authorization_code");
    expect(body.get("code")).toBe("the-code");
    expect(body.get("code_verifier")).toBe("the-verifier");
  });

  it("sends the refresh grant, and reads no new refresh token when Google sends none", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(jsonResponse({ access_token: "ya29.b", expires_in: 3600 }));
    vi.stubGlobal("fetch", fetchMock);

    const tokens = await refreshAccessToken("1//old");

    expect(tokens.refreshToken).toBeUndefined();
    const body = new URLSearchParams(fetchMock.mock.calls[0][1].body as URLSearchParams);
    expect(body.get("grant_type")).toBe("refresh_token");
    expect(body.get("refresh_token")).toBe("1//old");
  });

  it("treats invalid_grant as permanent — the only failure that ends a connection", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(jsonResponse({ error: "invalid_grant" }, 400)),
    );
    await expect(refreshAccessToken("dead")).rejects.toMatchObject({
      code: "invalid_grant",
      permanent: true,
    });
  });

  it.each([
    ["a Google 5xx", jsonResponse({}, 503), "server_error"],
    ["a misconfigured client", jsonResponse({ error: "invalid_client" }, 401), "invalid_client"],
  ])("does not treat %s as permanent", async (_name, response, code) => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(response));
    const error = await refreshAccessToken("token").catch((e) => e);
    expect(error).toBeInstanceOf(GoogleAuthError);
    expect(error).toMatchObject({ code, permanent: false });
  });
});

describe("revokeToken", () => {
  it("reports success, and swallows a failure rather than throwing", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("{}", { status: 200 })));
    await expect(revokeToken("t")).resolves.toBe(true);

    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("offline")));
    await expect(revokeToken("t")).resolves.toBe(false);
  });
});

describe("identityFromIdToken", () => {
  const good = {
    iss: "https://accounts.google.com",
    aud: CLIENT_ID,
    email: "Nora@Acme.CO",
    email_verified: true,
    sub: "123",
  };

  it("returns the verified address, lowercased", () => {
    expect(identityFromIdToken(idToken(good))).toEqual({ email: "nora@acme.co", sub: "123" });
  });

  it.each([
    ["another client's audience", { ...good, aud: "someone-else" }],
    ["a foreign issuer", { ...good, iss: "https://evil.example" }],
    ["an unverified address", { ...good, email_verified: false }],
    ["no address", { ...good, email: undefined }],
  ])("refuses %s", (_name, claims) => {
    expect(identityFromIdToken(idToken(claims))).toBeNull();
  });

  it("refuses garbage and absence", () => {
    expect(identityFromIdToken("not-a-jwt")).toBeNull();
    expect(identityFromIdToken(undefined)).toBeNull();
  });
});
