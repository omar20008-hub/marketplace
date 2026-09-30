import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The two ends of connecting Drive, and the keep-alive endpoint.
 *
 * The callback is the one that matters: it turns a request from the open
 * internet into a stored credential, so every way of arriving without the state
 * this app issued to this user has to end in a refusal and no account.
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
const { GET: start } = await import("@/app/api/oauth/google/start/route");
const { GET: callback } = await import("@/app/api/oauth/google/callback/route");
const { POST: keepalive } = await import("@/app/api/accounts/keepalive/route");
const { newOAuthState, OAUTH_COOKIE } = await import("@/lib/oauth-state");
const { DRIVE_READONLY_SCOPE, GOOGLE_DRIVE_CREDENTIAL } = await import("@/lib/google-oauth");

const APP = "https://app.example.test";
const PLAN_ID = "test-plan-oauth-routes";

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

function idToken(over: Record<string, unknown> = {}) {
  const claims = {
    iss: "https://accounts.google.com",
    aud: process.env.GOOGLE_CLIENT_ID,
    email: "nora@acme.co",
    email_verified: true,
    sub: "1",
    ...over,
  };
  return `h.${Buffer.from(JSON.stringify(claims)).toString("base64url")}.s`;
}

function googleGrants(scope: string, over: Record<string, unknown> = {}) {
  vi.stubGlobal(
    "fetch",
    vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          access_token: "ya29.x",
          refresh_token: "1//r",
          expires_in: 3600,
          scope,
          id_token: idToken(),
          ...over,
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    ),
  );
}

const FULL_SCOPE = `openid email ${DRIVE_READONLY_SCOPE}`;

/** Starts a sign-in as this user and returns what Google would echo back. */
function issued(userId: string, returnTo = "/marketplace/kb/setup") {
  const { nonce, cookie } = newOAuthState({ userId, verifier: "verifier", returnTo });
  return { nonce, cookie };
}

function callbackRequest(query: string, cookie?: string) {
  return new Request(`${APP}/api/oauth/google/callback?${query}`, {
    headers: cookie ? { cookie: `${OAUTH_COOKIE}=${cookie}` } : {},
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

describe("GET /api/oauth/google/start", () => {
  it("sends the user to Google with a signed, httpOnly, path-scoped state cookie", async () => {
    const user = await seedUser();
    const response = await start(
      new Request(`${APP}/api/oauth/google/start?returnTo=${encodeURIComponent("/marketplace/kb/setup")}`),
    );

    expect(response.status).toBe(307);
    const target = location(response);
    expect(target.host).toBe("accounts.google.com");
    expect(target.searchParams.get("access_type")).toBe("offline");
    expect(target.searchParams.get("prompt")).toBe("consent");
    expect(target.searchParams.get("state")).toBeTruthy();

    const setCookie = response.headers.get("set-cookie")!;
    expect(setCookie).toContain(`${OAUTH_COOKIE}=`);
    expect(setCookie.toLowerCase()).toContain("httponly");
    expect(setCookie).toContain("Path=/api/oauth/google");
    expect(setCookie).toContain("SameSite=lax");
    // The PKCE verifier stays in the cookie; only its hash goes to Google.
    expect(target.toString()).not.toContain("verifier");
    expect(user.id).toBeTruthy();
  });
});

describe("GET /api/oauth/google/callback", () => {
  it("stores the account and returns the user where they started", async () => {
    const user = await seedUser();
    googleGrants(FULL_SCOPE);
    const { nonce, cookie } = issued(user.id);

    const response = await callback(callbackRequest(`code=abc&state=${nonce}`, cookie));

    const to = location(response);
    expect(to.origin + to.pathname).toBe(`${APP}/marketplace/kb/setup`);
    expect(to.searchParams.get("connected")).toBe(GOOGLE_DRIVE_CREDENTIAL);
    const account = await prisma.connectedAccount.findFirstOrThrow();
    expect(account).toMatchObject({
      userId: user.id,
      accountRef: "nora@acme.co",
      status: "ACTIVE",
    });
    // The state cookie is spent.
    expect(response.headers.get("set-cookie")).toMatch(/Max-Age=0/i);
  });

  it("refuses a request with no state cookie", async () => {
    await seedUser();
    googleGrants(FULL_SCOPE);
    const response = await callback(callbackRequest("code=abc&state=whatever"));
    expect(location(response).searchParams.get("connect_error")).toBe("state");
    expect(await prisma.connectedAccount.count()).toBe(0);
  });

  it("refuses a state that does not match the cookie", async () => {
    const user = await seedUser();
    googleGrants(FULL_SCOPE);
    const { cookie } = issued(user.id);
    const response = await callback(callbackRequest("code=abc&state=forged", cookie));
    expect(location(response).searchParams.get("connect_error")).toBe("state");
    expect(await prisma.connectedAccount.count()).toBe(0);
  });

  it("refuses a sign-in that another user started", async () => {
    const user = await seedUser();
    googleGrants(FULL_SCOPE);
    const { nonce, cookie } = issued("someone-else");
    const response = await callback(callbackRequest(`code=abc&state=${nonce}`, cookie));
    expect(location(response).searchParams.get("connect_error")).toBe("state");
    expect(await prisma.connectedAccount.count()).toBe(0);
    expect(user.id).not.toBe("someone-else");
  });

  it("reports a declined consent screen without storing anything", async () => {
    const user = await seedUser();
    const { nonce, cookie } = issued(user.id);
    const response = await callback(callbackRequest(`error=access_denied&state=${nonce}`, cookie));
    expect(location(response).searchParams.get("connect_error")).toBe("denied");
    expect(await prisma.connectedAccount.count()).toBe(0);
  });

  it("reports a missing Drive permission, and stores nothing", async () => {
    const user = await seedUser();
    googleGrants("openid email");
    const { nonce, cookie } = issued(user.id);
    const response = await callback(callbackRequest(`code=abc&state=${nonce}`, cookie));
    expect(location(response).searchParams.get("connect_error")).toBe("scope");
    expect(await prisma.connectedAccount.count()).toBe(0);
  });

  it("refuses an id_token issued to a different client", async () => {
    const user = await seedUser();
    googleGrants(FULL_SCOPE, { id_token: idToken({ aud: "another-client" }) });
    const { nonce, cookie } = issued(user.id);
    const response = await callback(callbackRequest(`code=abc&state=${nonce}`, cookie));
    expect(location(response).searchParams.get("connect_error")).toBe("identity");
    expect(await prisma.connectedAccount.count()).toBe(0);
  });

  it("never returns the user anywhere but a path on this app", async () => {
    const user = await seedUser();
    googleGrants(FULL_SCOPE);
    const { nonce, cookie } = issued(user.id, "https://evil.example/steal");
    const response = await callback(callbackRequest(`code=abc&state=${nonce}`, cookie));
    expect(location(response).origin).toBe(APP);
    expect(location(response).pathname).toBe("/accounts");
  });

  it("reports a Google failure calmly", async () => {
    const user = await seedUser();
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new TypeError("offline")));
    vi.spyOn(console, "error").mockImplementation(() => {});
    const { nonce, cookie } = issued(user.id);
    const response = await callback(callbackRequest(`code=abc&state=${nonce}`, cookie));
    expect(location(response).searchParams.get("connect_error")).toBe("google");
  });
});

describe("POST /api/accounts/keepalive", () => {
  it("is refused without the schedule token", async () => {
    const none = await keepalive(new Request(`${APP}/api/accounts/keepalive`, { method: "POST" }));
    const wrong = await keepalive(
      new Request(`${APP}/api/accounts/keepalive`, {
        method: "POST",
        headers: { "x-schedule-token": "nope" },
      }),
    );
    expect(none.status).toBe(401);
    expect(wrong.status).toBe(401);
  });

  it("runs with it", async () => {
    const response = await keepalive(
      new Request(`${APP}/api/accounts/keepalive`, {
        method: "POST",
        headers: { "x-schedule-token": process.env.SCHEDULE_TOKEN! },
      }),
    );
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ ok: true, checked: 0 });
  });
});
