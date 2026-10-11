import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * "Sign in with Google" for someone who is not signed in. Unlike Drive
 * connection, it must never ask for Drive, must come back to its own callback,
 * and must refuse any identity Google has not verified.
 */

vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/lib/session", () => ({ createSession: vi.fn() }));

const { createSession } = await import("@/lib/session");
const { prisma } = await import("@/lib/db");
const { GET: start } = await import("@/app/api/oauth/google/auth/start/route");
const { GET: callback } = await import("@/app/api/oauth/google/auth/callback/route");
const { newOAuthState, OAUTH_COOKIE } = await import("@/lib/oauth-state");
const { DRIVE_READONLY_SCOPE } = await import("@/lib/google-oauth");

const APP = "https://app.example.test";

async function wipe() {
  await prisma.user.deleteMany({});
  await prisma.plan.deleteMany({});
}

function idToken(over: Record<string, unknown> = {}) {
  const claims = {
    iss: "https://accounts.google.com",
    aud: process.env.GOOGLE_CLIENT_ID,
    email: "new.person@acme.co",
    email_verified: true,
    sub: "42",
    ...over,
  };
  return `h.${Buffer.from(JSON.stringify(claims)).toString("base64url")}.s`;
}

function googleGrants(over: Record<string, unknown> = {}) {
  vi.stubGlobal(
    "fetch",
    vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          access_token: "ya29.x",
          expires_in: 3600,
          scope: "openid email",
          id_token: idToken(),
          ...over,
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    ),
  );
}

function callbackRequest(query: string, cookie?: string) {
  return new Request(`${APP}/api/oauth/google/auth/callback?${query}`, {
    headers: cookie ? { cookie: `${OAUTH_COOKIE}=${cookie}` } : {},
  });
}

function location(response: Response) {
  return new URL(response.headers.get("location")!);
}

beforeEach(async () => {
  await wipe();
  await prisma.plan.create({
    data: { id: "free", name: "Free", monthlyRuns: 1, storageBytes: BigInt(1), monthlyCredits: 0 },
  });
  vi.mocked(createSession).mockClear();
});
afterEach(() => vi.unstubAllGlobals());
afterAll(async () => {
  await wipe();
  await prisma.$disconnect();
});

describe("GET /api/oauth/google/auth/start", () => {
  it("asks Google for identity only and returns to its own callback", async () => {
    const response = await start(new Request(`${APP}/api/oauth/google/auth/start`));

    expect(response.status).toBe(307);
    const target = location(response);
    expect(target.host).toBe("accounts.google.com");
    expect(target.searchParams.get("redirect_uri")).toBe(
      `${APP}/api/oauth/google/auth/callback`,
    );
    expect(target.searchParams.get("scope")).not.toContain(DRIVE_READONLY_SCOPE);
    expect(response.headers.get("set-cookie")).toContain(`${OAUTH_COOKIE}=`);
  });
});

describe("GET /api/oauth/google/auth/callback", () => {
  it("creates an account for a new address and signs it in", async () => {
    googleGrants();
    const { nonce, cookie } = newOAuthState({ userId: "", verifier: "v", returnTo: "/" });

    const response = await callback(callbackRequest(`code=abc&state=${nonce}`, cookie));

    expect(location(response).pathname).toBe("/");
    const user = await prisma.user.findUniqueOrThrow({ where: { email: "new.person@acme.co" } });
    expect(user.planId).toBe("free");
    expect(createSession).toHaveBeenCalledWith(user.id);
  });

  it("signs an existing account in without creating a second one", async () => {
    const existing = await prisma.user.create({
      data: {
        email: "new.person@acme.co",
        name: "New",
        passwordHash: "x",
        initials: "N",
        planId: "free",
      },
    });
    googleGrants();
    const { nonce, cookie } = newOAuthState({ userId: "", verifier: "v", returnTo: "/" });

    await callback(callbackRequest(`code=abc&state=${nonce}`, cookie));

    expect(await prisma.user.count()).toBe(1);
    expect(createSession).toHaveBeenCalledWith(existing.id);
  });

  it("refuses an address Google has not verified", async () => {
    googleGrants({ id_token: idToken({ email_verified: false }) });
    const { nonce, cookie } = newOAuthState({ userId: "", verifier: "v", returnTo: "/" });

    const response = await callback(callbackRequest(`code=abc&state=${nonce}`, cookie));

    expect(location(response).searchParams.get("auth_error")).toBe("identity");
    expect(await prisma.user.count()).toBe(0);
  });

  it("refuses a request with no state cookie", async () => {
    googleGrants();
    const response = await callback(callbackRequest("code=abc&state=whatever"));
    expect(location(response).searchParams.get("auth_error")).toBe("state");
    expect(await prisma.user.count()).toBe(0);
  });
});
