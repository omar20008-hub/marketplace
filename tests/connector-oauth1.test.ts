import { afterEach, describe, expect, it, vi } from "vitest";
import { findProvider, type ConnectorProvider } from "@/lib/connectors/providers";
import { oauthSignature, percentEncode } from "@/lib/connectors/oauth1";
import { postToTokenEndpoint } from "@/lib/connectors/token-request";

/**
 * The two signatures below were computed with oauthlib (the reference Python
 * library for RFC 5849) over the same requests, so they check the signing itself,
 * not just that the code runs.
 */
describe("OAuth 1.0a signing", () => {
  it("percent-encodes the characters RFC 3986 escapes and encodeURIComponent does not", () => {
    expect(percentEncode("a b!'()*~")).toBe("a%20b%21%27%28%29%2A~");
  });

  it("matches the reference signature for the request-token step", () => {
    const signature = oauthSignature(
      "POST",
      "https://trello.com/1/OAuthGetRequestToken",
      {
        oauth_consumer_key: "key",
        oauth_nonce: "abc123",
        oauth_signature_method: "HMAC-SHA1",
        oauth_timestamp: "1700000000",
        oauth_version: "1.0",
        oauth_callback: "https://example.com/cb?state=abc",
      },
      "secret",
      "",
    );
    expect(signature).toBe("DlutnjvcHEjlNaUWO2CIhXvMO/E=");
  });

  it("matches the reference signature for the access-token step, with a token secret", () => {
    const signature = oauthSignature(
      "POST",
      "https://trello.com/1/OAuthGetAccessToken",
      {
        oauth_consumer_key: "key",
        oauth_nonce: "n2",
        oauth_signature_method: "HMAC-SHA1",
        oauth_timestamp: "1700000100",
        oauth_version: "1.0",
        oauth_token: "req-tok",
        oauth_verifier: "ver-123",
      },
      "secret",
      "req-sec",
    );
    expect(signature).toBe("kW+IWDrdcub2sk06RofxYiBJHu8=");
  });
});

describe("token endpoint requests", () => {
  const base = (overrides: Partial<ConnectorProvider>): ConnectorProvider => ({
    id: "x",
    credentialType: "xApi",
    displayName: "X",
    initials: "X",
    authorizeUrl: "https://example.test/authorize",
    tokenUrl: "https://example.test/token",
    scopes: [],
    clientId: () => "the-id",
    clientSecret: () => "the-secret",
    settingNames: ["X_ID", "X_SECRET"],
    accountFrom: () => null,
    signIn: true,
    ...overrides,
  });

  afterEach(() => vi.unstubAllGlobals());

  function capture() {
    const calls: { headers: Record<string, string>; body: string }[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init: { headers: Record<string, string>; body: string }) => {
        calls.push({ headers: init.headers, body: init.body });
        return new Response("{}", { status: 200 });
      }),
    );
    return calls;
  }

  it("sends the client credentials in the body by default, as a form", async () => {
    const calls = capture();
    await postToTokenEndpoint(base({}), { grant_type: "refresh_token", refresh_token: "r" });
    const body = new URLSearchParams(calls[0].body);
    expect(calls[0].headers["content-type"]).toBe("application/x-www-form-urlencoded");
    expect(body.get("client_id")).toBe("the-id");
    expect(body.get("client_secret")).toBe("the-secret");
    expect(calls[0].headers.authorization).toBeUndefined();
  });

  it("sends the client credentials as a Basic header when the tool asks for it", async () => {
    const calls = capture();
    await postToTokenEndpoint(base({ tokenAuth: "basic" }), { grant_type: "authorization_code", code: "c" });
    const expected = `Basic ${Buffer.from("the-id:the-secret").toString("base64")}`;
    expect(calls[0].headers.authorization).toBe(expected);
    const body = new URLSearchParams(calls[0].body);
    expect(body.get("client_id")).toBeNull();
    expect(body.get("client_secret")).toBeNull();
    expect(body.get("code")).toBe("c");
  });

  it("sends a JSON body when the tool asks for one", async () => {
    const calls = capture();
    await postToTokenEndpoint(base({ tokenBody: "json", tokenAuth: "basic" }), {
      grant_type: "authorization_code",
      code: "c",
    });
    expect(calls[0].headers["content-type"]).toBe("application/json");
    expect(JSON.parse(calls[0].body)).toEqual({ grant_type: "authorization_code", code: "c" });
  });
});

describe("account readers", () => {
  it("reads a Notion person from the token answer, with no identity call", () => {
    const notion = findProvider("notion")!;
    expect(notion.identityUrl).toBeUndefined();
    expect(
      notion.identityFromToken!({
        workspace_id: "w1",
        workspace_name: "Acme",
        owner: { type: "user", user: { person: { email: "Nora@Acme.co" } } },
      }),
    ).toEqual({ accountRef: "nora@acme.co", label: "Acme (Notion)" });
  });

  it("falls back to the workspace id when Notion gives no email", () => {
    const notion = findProvider("notion")!;
    expect(notion.identityFromToken!({ workspace_id: "W9" })).toEqual({
      accountRef: "w9",
      label: "Notion (Notion)",
    });
  });

  it("reads an Airtable account by email when the token has that scope, else by id", () => {
    const airtable = findProvider("airtable")!;
    expect(airtable.accountFrom({ id: "usrX", email: "a@b.co" })).toEqual({
      accountRef: "a@b.co",
      label: "a@b.co (Airtable)",
    });
    expect(airtable.accountFrom({ id: "usrX" })).toEqual({ accountRef: "usrx", label: "Airtable" });
  });

  it("reads a Stripe connected account from the token answer, by its account id", () => {
    const stripe = findProvider("stripe")!;
    expect(stripe.identityUrl).toBeUndefined();
    expect(stripe.identityFromToken!({ stripe_user_id: "acct_123", access_token: "x" })).toEqual({
      accountRef: "acct_123",
      label: "Stripe account acct_123",
    });
    expect(stripe.identityFromToken!({})).toBeNull();
  });

  it("reads a Microsoft 365 account by mail, else user principal name", () => {
    const microsoft = findProvider("microsoft365")!;
    expect(microsoft.accountFrom({ id: "g1", mail: "Nora@Acme.co", displayName: "Nora" })).toEqual({
      accountRef: "nora@acme.co",
      label: "Nora (Microsoft 365)",
    });
    expect(microsoft.accountFrom({ id: "g1", userPrincipalName: "nora@acme.onmicrosoft.com" })).toEqual({
      accountRef: "nora@acme.onmicrosoft.com",
      label: "Microsoft 365",
    });
  });

  it("leaves out the client id on Stripe's token request, and keeps it elsewhere", async () => {
    const calls: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init: { body: string }) => {
        calls.push(init.body);
        return new Response("{}", { status: 200 });
      }),
    );
    await postToTokenEndpoint(findProvider("stripe")!, { grant_type: "authorization_code", code: "ac_1" });
    await postToTokenEndpoint(findProvider("microsoft365")!, { grant_type: "authorization_code", code: "ac_1" });
    const stripeBody = new URLSearchParams(calls[0]);
    const microsoftBody = new URLSearchParams(calls[1]);
    expect(stripeBody.get("client_id")).toBeNull();
    expect(stripeBody.get("client_secret")).not.toBeNull();
    expect(microsoftBody.get("client_id")).not.toBeNull();
    vi.unstubAllGlobals();
  });

  it("reads a Trello member by username", () => {
    const trello = findProvider("trello")!;
    expect(trello.accountFrom({ username: "NoraH", fullName: "Nora Haddad" })).toEqual({
      accountRef: "norah",
      label: "Nora Haddad (Trello)",
    });
    expect(trello.oauth1).toBeDefined();
    expect(trello.credentialType).toBe("trelloApi");
  });
});
