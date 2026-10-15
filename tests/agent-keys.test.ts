import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Per-person keys for the personal assistant. A key identifies one person, is
 * stored only as a hash, and stops working the moment it is revoked.
 */

vi.mock("server-only", () => ({}));

const { prisma } = await import("@/lib/db");
const keys = await import("@/server/agent-keys");
const linkRoute = await import("@/app/api/vault/request-link/route");

const PLAN_ID = "test-plan-agent-keys";

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

beforeEach(async () => {
  await prisma.agentKey.deleteMany({});
  await prisma.auditLog.deleteMany({});
  await prisma.user.deleteMany({});
  await prisma.plan.deleteMany({});
});

describe("agent keys", () => {
  it("resolves a fresh key to its owner, and nothing else", async () => {
    const owner = await seedUser("key-owner@example.test");
    const key = await keys.issueAgentKey(owner.id);
    expect(await keys.userForAgentKey(key)).toBe(owner.id);
    expect(await keys.userForAgentKey("ak_guessed")).toBeNull();
    expect(await keys.userForAgentKey("")).toBeNull();
  });

  it("stores only the hash, never the key itself", async () => {
    const owner = await seedUser("hash-only@example.test");
    const key = await keys.issueAgentKey(owner.id);
    const row = await prisma.agentKey.findFirstOrThrow({ where: { userId: owner.id } });
    expect(row.keyHash).toBe(keys.hashAgentKey(key));
    expect(row.keyHash).not.toContain(key);
  });

  it("stops working as soon as it is revoked", async () => {
    const owner = await seedUser("revoke@example.test");
    const key = await keys.issueAgentKey(owner.id);
    expect(await keys.agentKeyActive(owner.id)).toBe(true);
    await keys.revokeAgentKeys(owner.id);
    expect(await keys.userForAgentKey(key)).toBeNull();
    expect(await keys.agentKeyActive(owner.id)).toBe(false);
  });

  it("reads the bearer token only from a well-formed Authorization header", () => {
    const req = (value: string | null) =>
      new Request("https://app.example.test/x", value === null ? {} : { headers: { authorization: value } });
    expect(keys.bearerToken(req("Bearer ak_abc"))).toBe("ak_abc");
    expect(keys.bearerToken(req("Basic ak_abc"))).toBe("");
    expect(keys.bearerToken(req("Bearer two words"))).toBe("");
    expect(keys.bearerToken(req(null))).toBe("");
  });
});

describe("link endpoint", () => {
  function linkRequest(key: string | null, body: Record<string, unknown>) {
    return new Request("https://app.example.test/api/vault/request-link", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(key ? { authorization: `Bearer ${key}` } : {}),
      },
      body: JSON.stringify(body),
    });
  }

  it("refuses a call without a person's key", async () => {
    const res = await linkRoute.POST(linkRequest(null, { siteUrl: "https://shop.example.com/" }));
    expect(res.status).toBe(401);
  });

  it("creates the link for the key's owner, even when another id is in the body", async () => {
    const owner = await seedUser("link-owner@example.test");
    const other = await seedUser("link-other@example.test");
    const key = await keys.issueAgentKey(other.id);

    const res = await linkRoute.POST(
      linkRequest(key, { userId: owner.id, siteUrl: "https://shop.example.com/" }),
    );
    expect(res.status).toBe(200);
    const row = await prisma.siteLoginRequest.findFirstOrThrow({ where: { siteUrl: "https://shop.example.com/" } });
    expect(row.userId).toBe(other.id);
    expect(row.userId).not.toBe(owner.id);
  });
});
