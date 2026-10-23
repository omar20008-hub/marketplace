import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * Every sign-in provider, configured as a deployment would be, must produce a
 * sign-in link to its own tool with the app's id, the callback on this app, and
 * the scopes it needs. This does not reach the tools; it catches a provider whose
 * settings or callback path are wrong before a person ever sees the button.
 */

const settings = {
  asana: { clientId: "asana-id", clientSecret: "asana-secret" },
  notion: { clientId: "notion-id", clientSecret: "notion-secret" },
  airtable: { clientId: "airtable-id", clientSecret: "airtable-secret" },
  trello: { clientId: "trello-key", clientSecret: "trello-secret" },
  microsoft: { clientId: "ms-id", clientSecret: "ms-secret" },
  stripe: { connectClientId: "ca_123", secretKey: "sk_test_x", webhookSecret: "", priceIds: { pro: "", team: "" } },
  google: { clientId: "g-id", clientSecret: "g-secret", redirectUri: "" },
  authSecret: "test-auth-secret-that-is-long-enough-123456",
  publicUrl: "https://app.example.test",
};

vi.mock("@/lib/env", () => ({ env: settings }));
vi.mock("@/lib/db", () => ({ prisma: {} }));

const { findProvider, missingSettings, listProviders } = await import("@/lib/connectors/providers");
const { beginSignIn } = await import("@/lib/connectors/sign-in");

const request = new Request("https://app.example.test/api/connectors/x/start");

describe("sign-in links for every configured provider", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("lists every sign-in provider, and none is missing settings once configured", () => {
    const ids = listProviders().map((p) => p.id).sort();
    expect(ids).toEqual(["airtable", "asana", "microsoft365", "notion", "stripe", "trello"]);
    for (const provider of listProviders()) {
      expect(missingSettings(provider), provider.id).toEqual([]);
    }
  });

  it.each([
    ["asana", "asana-id", []],
    ["notion", "notion-id", []],
    ["airtable", "airtable-id", ["data.records:read", "data.records:write", "schema.bases:read"]],
    ["microsoft365", "ms-id", ["offline_access", "User.Read", "Files.ReadWrite.All", "Sites.ReadWrite.All"]],
    ["stripe", "ca_123", ["read_write"]],
  ])("builds an OAuth 2 link for %s", async (id, clientId, scopes) => {
    const provider = findProvider(id)!;
    const { url, cookie } = await beginSignIn(provider, { userId: "u1", returnTo: "/accounts", request });
    const link = new URL(url);

    const authorize = new URL(provider.authorizeUrl);
    expect(link.origin + link.pathname).toBe(authorize.origin + authorize.pathname);
    expect(link.searchParams.get("client_id")).toBe(clientId);
    expect(link.searchParams.get("redirect_uri")).toBe(
      `https://app.example.test/api/connectors/${id}/callback`,
    );
    expect(link.searchParams.get("response_type")).toBe("code");
    expect(link.searchParams.get("state")).toBeTruthy();
    if (scopes.length > 0) expect(link.searchParams.get("scope")).toBe(scopes.join(" "));
    expect(cookie).toBeTruthy();
  });

  it("sends a PKCE challenge where the tool needs one (Airtable), and none elsewhere", async () => {
    const airtable = await beginSignIn(findProvider("airtable")!, { userId: "u1", returnTo: "/accounts", request });
    expect(new URL(airtable.url).searchParams.get("code_challenge_method")).toBe("S256");

    const notion = await beginSignIn(findProvider("notion")!, { userId: "u1", returnTo: "/accounts", request });
    expect(new URL(notion.url).searchParams.get("code_challenge")).toBeNull();
    expect(new URL(notion.url).searchParams.get("owner")).toBe("user");
  });

  it("starts Trello's OAuth 1.0a flow: a request token, then the approval link with it", async () => {
    const calls: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init: { body: string }) => {
        calls.push(url);
        const body = new URLSearchParams(init.body);
        // The callback must carry the state nonce, so the tool can send it back.
        expect(body.get("oauth_callback")).toMatch(
          /^https:\/\/app\.example\.test\/api\/connectors\/trello\/callback\?state=/,
        );
        expect(body.get("oauth_consumer_key")).toBe("trello-key");
        expect(body.get("oauth_signature")).toBeTruthy();
        return new Response("oauth_token=req-tok&oauth_token_secret=req-sec", { status: 200 });
      }),
    );

    const started = await beginSignIn(findProvider("trello")!, { userId: "u1", returnTo: "/accounts", request });
    const link = new URL(started.url);

    expect(calls).toEqual(["https://trello.com/1/OAuthGetRequestToken"]);
    expect(link.origin + link.pathname).toBe("https://trello.com/1/OAuthAuthorizeToken");
    expect(link.searchParams.get("oauth_token")).toBe("req-tok");
    expect(link.searchParams.get("scope")).toBe("read,write");
    expect(link.searchParams.get("expiration")).toBe("never");
  });

  it("reports a Trello start failure as a sign-in error rather than a broken link", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("denied", { status: 401 })));
    await expect(
      beginSignIn(findProvider("trello")!, { userId: "u1", returnTo: "/accounts", request }),
    ).rejects.toThrow("tool_token");
  });
});
