import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Saved website logins.
 *
 * Held to: a login is typed through a one-time link and nowhere else; the
 * password is sealed in the database; only the fill path returns it; the
 * browser cannot be pointed at a private or local address; and a person sees
 * and removes only their own logins.
 */

vi.mock("server-only", () => ({}));

const { prisma } = await import("@/lib/db");
const sites = await import("@/server/site-logins");
const fillRoute = await import("@/app/api/vault/credential/route");

const PLAN_ID = "test-plan-logins";

async function wipe() {
  await prisma.siteLogin.deleteMany({});
  await prisma.siteLoginRequest.deleteMany({});
  await prisma.auditLog.deleteMany({});
  await prisma.user.deleteMany({});
  await prisma.plan.deleteMany({});
}

async function seedUser(email: string) {
  await prisma.plan.upsert({
    where: { id: PLAN_ID },
    create: { id: PLAN_ID, name: "Test", monthlyRuns: 10, storageBytes: BigInt(1000), monthlyCredits: 0 },
    update: {},
  });
  return prisma.user.create({
    data: { email, name: "Person", passwordHash: "x", initials: "PE", planId: PLAN_ID },
    select: { id: true },
  });
}

beforeEach(wipe);
afterAll(async () => {
  await wipe();
  await prisma.$disconnect();
});

describe("normalizeSiteUrl", () => {
  it("accepts a public https address and keeps its path", () => {
    expect(sites.normalizeSiteUrl("https://Shop.Example.com/login")).toEqual({
      siteUrl: "https://shop.example.com/login",
      host: "shop.example.com",
    });
  });

  it.each([
    "http://shop.example.com",
    "https://localhost/login",
    "https://intranet/login",
    "https://router.local/",
    "https://192.168.1.1/",
    "https://169.254.169.254/latest/meta-data",
    "https://[::1]/",
    "https://shop.example.com:8443/",
    "https://user:pass@shop.example.com/",
    "not a url",
  ])("refuses %s", (input) => {
    expect(sites.normalizeSiteUrl(input)).toHaveProperty("error");
  });
});

describe("saving a login through the one-time link", () => {
  it("stores the password sealed, and the list never shows it", async () => {
    const user = await seedUser("vault-a@example.test");
    const { token } = await sites.requestSiteLoginLink({
      userId: user.id,
      siteUrl: "https://shop.example.com/login",
    });

    const saved = await sites.saveSiteLogin({
      userId: user.id,
      token,
      username: "nora",
      password: "correct-horse-battery",
    });
    expect(saved).toEqual({ ok: true });

    const row = await prisma.siteLogin.findFirstOrThrow({ where: { userId: user.id } });
    expect(row.sealedSecret).not.toContain("correct-horse-battery");

    const listed = await sites.listSiteLogins(user.id);
    expect(listed).toHaveLength(1);
    expect(JSON.stringify(listed)).not.toContain("correct-horse-battery");
    expect(listed[0]).toMatchObject({ host: "shop.example.com", username: "nora" });
  });

  it("refuses a link opened by someone else, and a link used twice", async () => {
    const owner = await seedUser("vault-owner@example.test");
    const other = await seedUser("vault-other@example.test");
    const { token } = await sites.requestSiteLoginLink({
      userId: owner.id,
      siteUrl: "https://shop.example.com/",
    });

    const stolen = await sites.saveSiteLogin({ userId: other.id, token, username: "x", password: "y" });
    expect(stolen).toEqual({ ok: false, reason: "not_yours" });

    await sites.saveSiteLogin({ userId: owner.id, token, username: "x", password: "y" });
    const again = await sites.saveSiteLogin({ userId: owner.id, token, username: "x", password: "z" });
    expect(again).toEqual({ ok: false, reason: "used" });
  });

  it("refuses an expired link", async () => {
    const user = await seedUser("vault-expired@example.test");
    const issued = new Date("2026-10-11T10:00:00Z");
    const { token } = await sites.requestSiteLoginLink(
      { userId: user.id, siteUrl: "https://shop.example.com/" },
      issued,
    );
    const later = new Date(issued.getTime() + 11 * 60_000);
    const result = await sites.saveSiteLogin(
      { userId: user.id, token, username: "x", password: "y" },
      later,
    );
    expect(result).toEqual({ ok: false, reason: "expired" });
  });
});

describe("filling a login for the browser", () => {
  it("returns the password only through the fill path, and marks it used", async () => {
    const user = await seedUser("vault-fill@example.test");
    const { token } = await sites.requestSiteLoginLink({
      userId: user.id,
      siteUrl: "https://shop.example.com/",
    });
    await sites.saveSiteLogin({ userId: user.id, token, username: "nora", password: "pw-123" });

    const filled = await sites.fillSiteLogin({ userId: user.id, siteUrl: "https://shop.example.com/login" });
    expect(filled).toEqual({ username: "nora", password: "pw-123" });

    const row = await prisma.siteLogin.findFirstOrThrow({ where: { userId: user.id } });
    expect(row.lastUsedAt).not.toBeNull();
  });

  it("asks for a username when a site has two logins", async () => {
    const user = await seedUser("vault-two@example.test");
    for (const username of ["a", "b"]) {
      const { token } = await sites.requestSiteLoginLink({
        userId: user.id,
        siteUrl: "https://shop.example.com/",
      });
      await sites.saveSiteLogin({ userId: user.id, token, username, password: "p" });
    }
    const result = await sites.fillSiteLogin({ userId: user.id, siteUrl: "https://shop.example.com/" });
    expect(result).toEqual({ error: "ambiguous" });
  });

  it("lets only the owner remove a login, and records the removal", async () => {
    const owner = await seedUser("vault-del-owner@example.test");
    const other = await seedUser("vault-del-other@example.test");
    const { token } = await sites.requestSiteLoginLink({
      userId: owner.id,
      siteUrl: "https://shop.example.com/",
    });
    await sites.saveSiteLogin({ userId: owner.id, token, username: "nora", password: "p" });
    const row = await prisma.siteLogin.findFirstOrThrow({ where: { userId: owner.id } });

    expect(await sites.deleteSiteLogin(other.id, row.id)).toBe(false);
    expect(await sites.deleteSiteLogin(owner.id, row.id)).toBe(true);
    expect(await sites.listSiteLogins(owner.id)).toHaveLength(0);
    const audit = await prisma.auditLog.findFirst({ where: { action: "site-login.deleted" } });
    expect(audit?.subject).toBe("shop.example.com");
  });
});

describe("credential endpoint", () => {
  it("refuses a call without the channel token", async () => {
    const req = new Request("https://app.example.test/api/vault/credential", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ userId: "x", siteUrl: "https://shop.example.com/" }),
    });
    const res = await fillRoute.POST(req);
    expect(res.status).toBe(401);
  });
});
