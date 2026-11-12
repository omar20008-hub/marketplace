import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * GET /api/agent/whoami: an agent key says whose it is, and a missing, wrong or
 * revoked key says nothing. Also the file route the browser broker relies on: a
 * key opens its own person's file and nobody else's.
 */

vi.mock("server-only", () => ({}));
vi.mock("@/lib/auth", () => ({ currentUser: async () => null }));

const { prisma } = await import("@/lib/db");
const { issueAgentKey, revokeAgentKeys } = await import("@/server/agent-keys");
const { GET: whoami } = await import("@/app/api/agent/whoami/route");
const { GET: download } = await import("@/app/api/files/[id]/download/route");
const files = await import("@/server/files/user-files");

const PLAN_ID = "test-plan-whoami";

async function person(email: string) {
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

const asking = (key?: string) =>
  whoami(new Request("http://localhost/api/agent/whoami", { headers: key ? { authorization: `Bearer ${key}` } : {} }));

async function wipe() {
  await prisma.userFile.deleteMany({});
  await prisma.agentKey.deleteMany({});
  await prisma.user.deleteMany({});
  await prisma.plan.deleteMany({});
}

beforeEach(wipe);
afterAll(async () => {
  await wipe();
  await prisma.$disconnect();
});

describe("GET /api/agent/whoami", () => {
  it("tells a key's holder their own id, and each key its own person", async () => {
    const a = await person("a@example.test");
    const b = await person("b@example.test");
    const keyA = await issueAgentKey(a.id);
    const keyB = await issueAgentKey(b.id);

    const resA = await asking(keyA);
    expect(resA.status).toBe(200);
    expect(await resA.json()).toEqual({ userId: a.id });
    expect(resA.headers.get("cache-control")).toBe("no-store");
    expect(await (await asking(keyB)).json()).toEqual({ userId: b.id });
  });

  it("says nothing for no key, a wrong key or a revoked key", async () => {
    const a = await person("a@example.test");
    const key = await issueAgentKey(a.id);

    expect((await asking()).status).toBe(401);
    expect((await asking("ak_not-a-real-key")).status).toBe(401);
    const body = await (await asking("ak_not-a-real-key")).json();
    expect(JSON.stringify(body)).not.toContain(a.id);

    await revokeAgentKeys(a.id);
    expect((await asking(key)).status).toBe(401);
  });
});

describe("the file route with an agent key (what the browser broker calls)", () => {
  const get = (id: string, key: string) =>
    download(new Request(`http://localhost/api/files/${id}/download`, { headers: { authorization: `Bearer ${key}` } }), {
      params: Promise.resolve({ id }),
    });

  it("returns the bytes and the name of the key holder's own file only", async () => {
    const a = await person("a@example.test");
    const b = await person("b@example.test");
    const keyA = await issueAgentKey(a.id);
    const keyB = await issueAgentKey(b.id);
    const saved = await files.saveUserFile({
      userId: a.id,
      fileName: "السيرة الذاتية.txt",
      bytes: new TextEncoder().encode("my cv"),
      channel: "whatsapp",
    });
    if (!saved.ok) throw new Error(saved.error);

    const mine = await get(saved.id, keyA);
    expect(mine.status).toBe(200);
    expect(await mine.text()).toBe("my cv");
    expect(mine.headers.get("content-disposition")).toContain(`filename*=UTF-8''${encodeURIComponent("السيرة الذاتية.txt")}`);

    expect((await get(saved.id, keyB)).status).toBe(404);      // another person's key: not found, not forbidden
    expect((await get("does-not-exist-0001", keyA)).status).toBe(404);
  });
});
