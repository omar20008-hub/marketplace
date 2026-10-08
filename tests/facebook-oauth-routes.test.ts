import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * "Continue with Facebook": the two ends of the sign-in, and what the connection
 * does afterwards.
 *
 * As with Drive, the callback turns a request from the open internet into a stored
 * credential, so every way of arriving without the state this app issued to this
 * user has to end in a refusal and no account. And what is stored has to be exactly
 * what a pasted token would have made — `{ accessToken }` — so installing needs no
 * special case.
 */

const viewer = vi.hoisted(() => ({ current: null as { id: string } | null }));
vi.mock("@/lib/auth", () => ({
  requireUser: async () => {
    if (!viewer.current) throw new Error("no session in this test");
    return viewer.current;
  },
}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

const { prisma } = await import("@/lib/db");
const { GET: start } = await import("@/app/api/oauth/facebook/start/route");
const { GET: callback } = await import("@/app/api/oauth/facebook/callback/route");
const { newOAuthState, FACEBOOK_OAUTH_COOKIE } = await import("@/lib/oauth-state");
const { openCredential } = await import("@/lib/secrets");
const { FACEBOOK_CREDENTIAL } = await import("@/lib/credentials");
const { connectErrorText } = await import("@/lib/google-oauth");
const { expireFacebookAccounts } = await import("@/server/facebook-account");

const APP = "https://app.example.test";
const PLAN_ID = "test-plan-facebook-oauth";
const ALL = ["pages_show_list", "pages_read_engagement", "pages_manage_posts"];

async function wipe() {
  await prisma.installationCredential.deleteMany({});
  await prisma.installation.deleteMany({});
  await prisma.connectedAccount.deleteMany({});
  await prisma.user.deleteMany({});
  await prisma.plan.deleteMany({});
}

async function seedUser() {
  await prisma.plan.create({
    data: { id: PLAN_ID, name: "T", monthlyRuns: 1, storageBytes: BigInt(1), monthlyCredits: 0 },
  });
  const user = await prisma.user.create({
    data: { email: "u@example.test", name: "U", passwordHash: "x", initials: "U", planId: PLAN_ID },
  });
  viewer.current = user;
  return user;
}

/** Facebook's side of the conversation, answered by path. */
function facebookAnswers(
  over: { granted?: string[]; pages?: unknown[]; fail?: string; expiresIn?: number } = {},
) {
  const calls: string[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: URL | string) => {
      const url = new URL(String(input));
      calls.push(`${url.pathname}?${url.searchParams.get("grant_type") ?? ""}`);
      const json = (body: unknown, status = 200) =>
        new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

      if (over.fail && url.pathname.endsWith("/oauth/access_token")) {
        return json({ error: { message: over.fail, code: 100 } }, 400);
      }
      if (url.pathname.endsWith("/oauth/access_token")) {
        return url.searchParams.get("grant_type") === "fb_exchange_token"
          ? json({ access_token: "EAAlong", expires_in: over.expiresIn ?? 5183944 })
          : json({ access_token: "EAAshort" });
      }
      if (url.pathname.endsWith("/me/permissions")) {
        return json({
          data: (over.granted ?? [...ALL, "instagram_basic"]).map((permission) => ({
            permission,
            status: "granted",
          })),
        });
      }
      if (url.pathname.endsWith("/me/accounts")) {
        return json({
          data: over.pages ?? [
            { id: "p1", name: "Acme Page", instagram_business_account: { id: "ig1" } },
          ],
        });
      }
      return json({ id: "u1", name: "Nora Acme" });
    }),
  );
  return calls;
}

function issued(userId: string, returnTo = "/marketplace/post-scheduler/setup") {
  return newOAuthState({ userId, verifier: "-", returnTo });
}

function callbackRequest(query: string, cookie?: string) {
  return new Request(`${APP}/api/oauth/facebook/callback?${query}`, {
    headers: cookie ? { cookie: `${FACEBOOK_OAUTH_COOKIE}=${cookie}` } : {},
  });
}

function location(response: Response) {
  return new URL(response.headers.get("location")!);
}

beforeEach(wipe);
afterEach(() => vi.unstubAllGlobals());
afterAll(async () => {
  await wipe();
  await prisma.$disconnect();
});

describe("GET /api/oauth/facebook/start", () => {
  it("sends the user to Facebook with the page permissions and a signed, path-scoped state cookie", async () => {
    await seedUser();
    const response = await start(
      new Request(`${APP}/api/oauth/facebook/start?returnTo=${encodeURIComponent("/accounts")}`),
    );

    expect(response.status).toBe(307);
    const target = location(response);
    expect(target.host).toBe("www.facebook.com");
    expect(target.searchParams.get("client_id")).toBe("1234567890");
    expect(target.searchParams.get("redirect_uri")).toBe(`${APP}/api/oauth/facebook/callback`);
    const scopes = target.searchParams.get("scope")!.split(",");
    expect(scopes).toEqual(expect.arrayContaining([...ALL, "instagram_content_publish"]));
    expect(target.searchParams.get("state")).toBeTruthy();
    // Only the client id travels to Facebook — never the app secret.
    expect(target.toString()).not.toContain("test-facebook-app-secret");

    const setCookie = response.headers.get("set-cookie")!;
    expect(setCookie).toContain(`${FACEBOOK_OAUTH_COOKIE}=`);
    expect(setCookie.toLowerCase()).toContain("httponly");
    expect(setCookie).toContain("Path=/api/oauth/facebook");
  });
});

describe("GET /api/oauth/facebook/callback", () => {
  it("keeps a long-lived token as the user's connection, in the shape a pasted token has", async () => {
    const user = await seedUser();
    const calls = facebookAnswers();
    const { nonce, cookie } = issued(user.id);

    const response = await callback(callbackRequest(`code=abc&state=${nonce}`, cookie));

    const to = location(response);
    expect(to.origin + to.pathname).toBe(`${APP}/marketplace/post-scheduler/setup`);
    expect(to.searchParams.get("connected")).toBe(FACEBOOK_CREDENTIAL);
    // The code is swapped for a short token and that for a long one.
    expect(calls.filter((c) => c.includes("/oauth/access_token"))).toHaveLength(2);

    const account = await prisma.connectedAccount.findFirstOrThrow({ where: { userId: user.id } });
    expect(account.credentialType).toBe(FACEBOOK_CREDENTIAL);
    expect(account.status).toBe("ACTIVE");
    expect(account.accountRef).toBe("Nora Acme · Acme Page");
    expect(account.secretJson).not.toContain("EAAlong");
    // Exactly the field n8n's credential has — an extra one would be refused there.
    expect(openCredential(account.secretJson)).toEqual({ accessToken: "EAAlong" });
    const days = (account.expiresAt!.getTime() - Date.now()) / 86_400_000;
    expect(days).toBeGreaterThan(55);
    expect(days).toBeLessThan(65);
  });

  it("signing in again replaces the connection rather than adding a second", async () => {
    const user = await seedUser();
    facebookAnswers();
    for (let i = 0; i < 2; i++) {
      const { nonce, cookie } = issued(user.id);
      await callback(callbackRequest(`code=abc&state=${nonce}`, cookie));
    }
    expect(await prisma.connectedAccount.count({ where: { userId: user.id } })).toBe(1);
  });

  it("replaces a token that was pasted earlier instead of sitting beside it", async () => {
    const user = await seedUser();
    const { sealCredential } = await import("@/lib/secrets");
    await prisma.connectedAccount.create({
      data: {
        userId: user.id,
        credentialType: FACEBOOK_CREDENTIAL,
        displayName: "Facebook & Instagram",
        initials: "FB",
        accountRef: user.email,
        status: "ACTIVE",
        secretJson: sealCredential({ accessToken: "pasted" }),
      },
    });
    facebookAnswers();
    const { nonce, cookie } = issued(user.id);
    await callback(callbackRequest(`code=abc&state=${nonce}`, cookie));

    const rows = await prisma.connectedAccount.findMany({ where: { userId: user.id } });
    expect(rows).toHaveLength(1);
    expect(openCredential(rows[0].secretJson)).toEqual({ accessToken: "EAAlong" });
  });

  it("refuses without the state cookie, with the wrong nonce, or for another user", async () => {
    const user = await seedUser();
    facebookAnswers();
    const { nonce, cookie } = issued(user.id);
    const other = issued("someone-else");

    const cases = [
      await callback(callbackRequest(`code=abc&state=${nonce}`)),
      await callback(callbackRequest("code=abc&state=wrong", cookie)),
      await callback(callbackRequest(`code=abc&state=${other.nonce}`, other.cookie)),
    ];
    for (const response of cases) {
      expect(location(response).searchParams.get("connect_error")).toBe("state");
    }
    expect(await prisma.connectedAccount.count()).toBe(0);
  });

  it("says so, and stores nothing, when the user declines", async () => {
    const user = await seedUser();
    const { nonce, cookie } = issued(user.id);
    const response = await callback(callbackRequest(`error=access_denied&state=${nonce}`, cookie));
    expect(location(response).searchParams.get("connect_error")).toBe("fb_denied");
    expect(await prisma.connectedAccount.count()).toBe(0);
  });

  it("refuses a sign-in where the posting permission was unticked", async () => {
    const user = await seedUser();
    facebookAnswers({ granted: ["pages_show_list", "pages_read_engagement"] });
    const { nonce, cookie } = issued(user.id);
    const response = await callback(callbackRequest(`code=abc&state=${nonce}`, cookie));
    expect(location(response).searchParams.get("connect_error")).toBe("fb_scope");
    expect(await prisma.connectedAccount.count()).toBe(0);
  });

  it("refuses an account with no Page to post to", async () => {
    const user = await seedUser();
    facebookAnswers({ pages: [] });
    const { nonce, cookie } = issued(user.id);
    const response = await callback(callbackRequest(`code=abc&state=${nonce}`, cookie));
    expect(location(response).searchParams.get("connect_error")).toBe("fb_no_pages");
    expect(await prisma.connectedAccount.count()).toBe(0);
  });

  it("returns the user with a message when Facebook errors, never with the token in the URL", async () => {
    const user = await seedUser();
    facebookAnswers({ fail: "Invalid verification code format." });
    const { nonce, cookie } = issued(user.id);
    const response = await callback(callbackRequest(`code=abc&state=${nonce}`, cookie));
    const to = location(response);
    expect(to.searchParams.get("connect_error")).toBe("fb_failed");
    expect(to.toString()).not.toContain("EAA");
    expect(connectErrorText("fb_failed")).toContain("Facebook");
  });

  it("clears the state cookie whichever way it ended", async () => {
    const user = await seedUser();
    const response = await callback(callbackRequest("code=abc&state=wrong"));
    expect(response.headers.get("set-cookie")).toContain(`${FACEBOOK_OAUTH_COOKIE}=;`);
    expect(user.id).toBeTruthy();
  });
});

describe("expireFacebookAccounts", () => {
  async function account(userId: string, expiresAt: Date | null, ref: string) {
    const { sealCredential } = await import("@/lib/secrets");
    return prisma.connectedAccount.create({
      data: {
        userId,
        credentialType: FACEBOOK_CREDENTIAL,
        displayName: "Facebook & Instagram",
        initials: "FB",
        accountRef: ref,
        status: "ACTIVE",
        secretJson: sealCredential({ accessToken: "t" }),
        expiresAt,
      },
    });
  }

  it("marks a sign-in whose 60 days ran out, drops its token, and leaves the rest alone", async () => {
    const user = await seedUser();
    const lapsed = await account(user.id, new Date(Date.now() - 1000), "a");
    const live = await account(user.id, new Date(Date.now() + 86_400_000), "b");
    const pasted = await account(user.id, null, "c");

    expect(await expireFacebookAccounts()).toBe(1);

    const after = async (id: string) =>
      prisma.connectedAccount.findUniqueOrThrow({ where: { id } });
    expect((await after(lapsed.id)).status).toBe("EXPIRED");
    expect((await after(lapsed.id)).secretJson).toBeNull();
    expect((await after(live.id)).status).toBe("ACTIVE");
    // A pasted token has no recorded lifetime, so it is never expired by the clock.
    expect((await after(pasted.id)).status).toBe("ACTIVE");
  });
});
