import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * A Google connection the platform holds, against real Postgres.
 *
 * The properties that make it durable are each pinned here: one renewal at a
 * time however many callers arrive together; a rotated refresh token kept; a
 * dead connection marked EXPIRED and made visible in My workspace; and — the one
 * that matters most — a transient failure never being mistaken for a dead one.
 */

vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

const { prisma } = await import("@/lib/db");
const { openCredential, sealCredential } = await import("@/lib/secrets");
const { GOOGLE_DRIVE_CREDENTIAL, DRIVE_READONLY_SCOPE } = await import("@/lib/google-oauth");
const { getGoogleAccessToken, keepGoogleAccountsAlive, saveGoogleConnection } = await import(
  "@/server/google-account"
);

const PLAN_ID = "test-plan-google";
const EMAIL = "nora@acme.co";

async function wipe() {
  await prisma.installationCredential.deleteMany({});
  await prisma.installation.deleteMany({});
  await prisma.requirement.deleteMany({});
  await prisma.connectedAccount.deleteMany({});
  await prisma.product.deleteMany({});
  await prisma.user.deleteMany({});
  await prisma.plan.deleteMany({});
}

async function seedUser() {
  await prisma.plan.create({
    data: { id: PLAN_ID, name: "T", monthlyRuns: 1, storageBytes: BigInt(1), monthlyCredits: 0 },
  });
  return prisma.user.create({
    data: {
      email: "owner@example.test",
      name: "Owner",
      passwordHash: "x",
      initials: "OW",
      planId: PLAN_ID,
    },
  });
}

function tokens(over: Partial<Parameters<typeof saveGoogleConnection>[0]["tokens"]> = {}) {
  return {
    accessToken: "ya29.first",
    refreshToken: "1//refresh-one",
    expiresAt: new Date(Date.now() + 3_600_000),
    scope: ["openid", "email", DRIVE_READONLY_SCOPE],
    ...over,
  };
}

function tokenReply(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

/** Connects an account whose access token is already stale, so the next use must renew. */
async function connectStale(userId: string, expiresAt = new Date(Date.now() - 1000)) {
  const saved = await saveGoogleConnection({
    userId,
    email: EMAIL,
    tokens: tokens({ expiresAt }),
  });
  if (!saved.ok) throw new Error("setup failed");
  return saved.accountId;
}

beforeEach(wipe);
afterEach(() => {
  vi.unstubAllGlobals();
});
afterAll(async () => {
  await wipe();
  await prisma.$disconnect();
});

describe("saveGoogleConnection", () => {
  it("stores an ACTIVE account with the tokens encrypted", async () => {
    const user = await seedUser();
    const result = await saveGoogleConnection({ userId: user.id, email: EMAIL, tokens: tokens() });
    expect(result.ok).toBe(true);

    const account = await prisma.connectedAccount.findFirstOrThrow();
    expect(account).toMatchObject({
      credentialType: GOOGLE_DRIVE_CREDENTIAL,
      accountRef: EMAIL,
      status: "ACTIVE",
    });
    expect(account.secretJson).not.toContain("refresh-one");
    expect(account.secretJson).not.toContain("ya29.first");
    expect(openCredential(account.secretJson)).toMatchObject({
      refresh_token: "1//refresh-one",
      access_token: "ya29.first",
    });
  });

  it("refuses a connection where the user unticked Drive", async () => {
    const user = await seedUser();
    const result = await saveGoogleConnection({
      userId: user.id,
      email: EMAIL,
      tokens: tokens({ scope: ["openid", "email"] }),
    });
    expect(result).toEqual({ ok: false, reason: "scope" });
    expect(await prisma.connectedAccount.count()).toBe(0);
  });

  it("refuses a first connection that came without a refresh token", async () => {
    const user = await seedUser();
    const result = await saveGoogleConnection({
      userId: user.id,
      email: EMAIL,
      tokens: tokens({ refreshToken: undefined }),
    });
    expect(result).toEqual({ ok: false, reason: "no_refresh" });
  });

  it("updates the same account in place on reconnect, keeping the old refresh token if none arrives", async () => {
    const user = await seedUser();
    await saveGoogleConnection({ userId: user.id, email: EMAIL, tokens: tokens() });

    const again = await saveGoogleConnection({
      userId: user.id,
      email: EMAIL,
      tokens: tokens({ accessToken: "ya29.second", refreshToken: undefined }),
    });
    expect(again.ok).toBe(true);

    expect(await prisma.connectedAccount.count()).toBe(1);
    const account = await prisma.connectedAccount.findFirstOrThrow();
    expect(openCredential(account.secretJson)).toMatchObject({
      refresh_token: "1//refresh-one",
      access_token: "ya29.second",
    });
  });

  it("brings an EXPIRED account back to ACTIVE", async () => {
    const user = await seedUser();
    await prisma.connectedAccount.create({
      data: {
        userId: user.id,
        credentialType: GOOGLE_DRIVE_CREDENTIAL,
        displayName: "Google Drive",
        initials: "GD",
        accountRef: EMAIL,
        status: "EXPIRED",
        secretJson: null,
      },
    });
    await saveGoogleConnection({ userId: user.id, email: EMAIL, tokens: tokens() });
    expect((await prisma.connectedAccount.findFirstOrThrow()).status).toBe("ACTIVE");
  });
});

describe("getGoogleAccessToken", () => {
  it("returns the stored token without calling Google while it is still good", async () => {
    const user = await seedUser();
    const id = await connectStale(user.id, new Date(Date.now() + 3_600_000));
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    await expect(getGoogleAccessToken(id)).resolves.toBe("ya29.first");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("renews a stale token, stores it, and uses the stored one next time", async () => {
    const user = await seedUser();
    const id = await connectStale(user.id);
    const fetchMock = vi
      .fn()
      .mockResolvedValue(tokenReply({ access_token: "ya29.renewed", expires_in: 3600 }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(getGoogleAccessToken(id)).resolves.toBe("ya29.renewed");
    await expect(getGoogleAccessToken(id)).resolves.toBe("ya29.renewed");

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const account = await prisma.connectedAccount.findFirstOrThrow();
    expect(account.expiresAt!.getTime()).toBeGreaterThan(Date.now() + 3_000_000);
    // The refresh token is untouched when Google does not rotate it.
    expect(openCredential(account.secretJson).refresh_token).toBe("1//refresh-one");
  });

  it("keeps a refresh token Google rotates", async () => {
    const user = await seedUser();
    const id = await connectStale(user.id);
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        tokenReply({ access_token: "ya29.n", refresh_token: "1//refresh-two", expires_in: 3600 }),
      ),
    );

    await getGoogleAccessToken(id);
    const account = await prisma.connectedAccount.findFirstOrThrow();
    expect(openCredential(account.secretJson).refresh_token).toBe("1//refresh-two");
  });

  it("renews once when several callers arrive together", async () => {
    const user = await seedUser();
    const id = await connectStale(user.id);
    const fetchMock = vi.fn().mockImplementation(async () => {
      await new Promise((resolve) => setTimeout(resolve, 60));
      return tokenReply({ access_token: "ya29.shared", expires_in: 3600 });
    });
    vi.stubGlobal("fetch", fetchMock);

    const results = await Promise.all([
      getGoogleAccessToken(id),
      getGoogleAccessToken(id),
      getGoogleAccessToken(id),
    ]);

    expect(results).toEqual(["ya29.shared", "ya29.shared", "ya29.shared"]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("marks the account EXPIRED on invalid_grant, drops the dead token, and says so in My workspace", async () => {
    const user = await seedUser();
    const product = await prisma.product.create({
      data: {
        slug: "kb",
        creatorId: user.id,
        title: "Knowledge",
        summary: "s",
        description: "d",
        needsFromYou: "n",
        kind: "WORKFLOW",
        category: "c",
        status: "PUBLISHED",
        requirements: {
          create: {
            kind: "CONNECTION",
            label: "Google Drive",
            credentialType: GOOGLE_DRIVE_CREDENTIAL,
            providedBy: "USER",
          },
        },
      },
    });
    await prisma.installation.create({
      data: { userId: user.id, productId: product.id, pinnedVersion: "1.0", status: "ACTIVE" },
    });
    const id = await connectStale(user.id);
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(tokenReply({ error: "invalid_grant" }, 400)));

    await expect(getGoogleAccessToken(id)).rejects.toMatchObject({ permanent: true });

    const account = await prisma.connectedAccount.findFirstOrThrow();
    expect(account).toMatchObject({ status: "EXPIRED", secretJson: null });
    expect(await prisma.installation.findFirstOrThrow()).toMatchObject({
      status: "PARTIAL",
      attentionNote: "Google Drive still needs connecting.",
    });
  });

  it.each([
    ["a network failure", () => Promise.reject(new TypeError("fetch failed"))],
    ["a Google 503", () => Promise.resolve(tokenReply({}, 503))],
  ])("leaves the account ACTIVE and its secret intact after %s", async (_name, reply) => {
    const user = await seedUser();
    const id = await connectStale(user.id);
    vi.stubGlobal("fetch", vi.fn().mockImplementation(reply));

    await expect(getGoogleAccessToken(id)).rejects.toBeDefined();

    const account = await prisma.connectedAccount.findFirstOrThrow();
    expect(account.status).toBe("ACTIVE");
    expect(openCredential(account.secretJson).refresh_token).toBe("1//refresh-one");
  });

  it("refuses an account that is not active without calling Google", async () => {
    const user = await seedUser();
    const account = await prisma.connectedAccount.create({
      data: {
        userId: user.id,
        credentialType: GOOGLE_DRIVE_CREDENTIAL,
        displayName: "Google Drive",
        initials: "GD",
        accountRef: EMAIL,
        status: "EXPIRED",
      },
    });
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    await expect(getGoogleAccessToken(account.id)).rejects.toMatchObject({
      code: "not_connected",
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("keepGoogleAccountsAlive", () => {
  it("renews an account idle for a week and leaves a recently used one alone", async () => {
    const user = await seedUser();
    const idle = await connectStale(user.id, new Date(Date.now() - 10 * 86_400_000));
    await prisma.connectedAccount.create({
      data: {
        userId: user.id,
        credentialType: GOOGLE_DRIVE_CREDENTIAL,
        displayName: "Google Drive",
        initials: "GD",
        accountRef: "second@acme.co",
        status: "ACTIVE",
        secretJson: sealCredential({ refresh_token: "1//other", access_token: "a" }),
        expiresAt: new Date(Date.now() - 3_600_000),
      },
    });
    const fetchMock = vi
      .fn()
      .mockResolvedValue(tokenReply({ access_token: "ya29.kept", expires_in: 3600 }));
    vi.stubGlobal("fetch", fetchMock);

    const summary = await keepGoogleAccountsAlive();

    expect(summary).toEqual({ checked: 1, renewed: 1, expired: 0, failed: 0 });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const renewed = await prisma.connectedAccount.findUniqueOrThrow({ where: { id: idle } });
    expect(openCredential(renewed.secretJson).access_token).toBe("ya29.kept");
  });

  it("counts a dead connection as expired and a flaky one as failed", async () => {
    const user = await seedUser();
    await connectStale(user.id, new Date(Date.now() - 10 * 86_400_000));
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(tokenReply({ error: "invalid_grant" }, 400)));
    expect(await keepGoogleAccountsAlive()).toMatchObject({ checked: 1, expired: 1, failed: 0 });

    await wipe();
    const again = await seedUser();
    await connectStale(again.id, new Date(Date.now() - 10 * 86_400_000));
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new TypeError("offline")));
    expect(await keepGoogleAccountsAlive()).toMatchObject({ checked: 1, expired: 0, failed: 1 });
  });
});
