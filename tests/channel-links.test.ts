import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Telegram linking.
 *
 * What is being held to: a chat is linked only when its owner proves control of
 * it by sending the code, a code works once and expires, a chat already held by
 * someone else is never taken over, and the channel calls n8n makes are refused
 * without the channel token.
 */

vi.mock("server-only", () => ({}));

const viewer = vi.hoisted(() => ({
  current: null as { id: string; email: string } | null,
}));
vi.mock("@/lib/auth", () => ({
  requireUser: async () => {
    if (!viewer.current) throw new Error("no session in this test");
    return viewer.current;
  },
}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

const { prisma } = await import("@/lib/db");
const links = await import("@/server/channel-links");
const actions = await import("@/server/channel-link-actions");
const linkRoute = await import("@/app/api/channels/telegram/link/route");
const resolveRoute = await import("@/app/api/channels/telegram/resolve/route");

const PLAN_ID = "test-plan-channels";

async function wipe() {
  await prisma.channelLinkCode.deleteMany({});
  await prisma.channelLink.deleteMany({});
  await prisma.auditLog.deleteMany({});
  await prisma.user.deleteMany({});
  await prisma.plan.deleteMany({});
}

async function seedUser(email: string) {
  await prisma.plan.upsert({
    where: { id: PLAN_ID },
    create: {
      id: PLAN_ID,
      name: "Test",
      monthlyRuns: 10,
      storageBytes: BigInt(1000),
      monthlyCredits: 0,
    },
    update: {},
  });
  return prisma.user.create({
    data: { email, name: "Person", passwordHash: "x", initials: "PE", planId: PLAN_ID },
    select: { id: true, email: true },
  });
}

function post(path: string, body: unknown, token: string | null = "test-channel-token") {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (token !== null) headers["x-channel-token"] = token;
  return new Request(`https://app.example.test${path}`, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
}

beforeEach(async () => {
  await wipe();
  viewer.current = null;
});

afterAll(async () => {
  await wipe();
  await prisma.$disconnect();
});

describe("linking a Telegram chat", () => {
  it("links the chat that sends the code, and resolves it afterwards", async () => {
    const user = await seedUser("link-a@example.test");
    const { code } = await links.issueTelegramCode(user.id);

    const result = await links.redeemTelegramCode({ code, externalId: "653345511" });
    expect(result).toEqual({ ok: true, userId: user.id });
    expect(await links.resolveTelegramUser("653345511")).toBe(user.id);
  });

  it("accepts the code in lower case, since people type it that way", async () => {
    const user = await seedUser("link-case@example.test");
    const { code } = await links.issueTelegramCode(user.id);

    const result = await links.redeemTelegramCode({
      code: code.toLowerCase(),
      externalId: "111",
    });
    expect(result.ok).toBe(true);
  });

  it("refuses a code that was already spent", async () => {
    const user = await seedUser("link-reuse@example.test");
    const { code } = await links.issueTelegramCode(user.id);
    await links.redeemTelegramCode({ code, externalId: "222" });

    const again = await links.redeemTelegramCode({ code, externalId: "333" });
    expect(again).toEqual({ ok: false, reason: "used" });
    expect(await links.resolveTelegramUser("333")).toBeNull();
  });

  it("refuses an expired code", async () => {
    const user = await seedUser("link-expired@example.test");
    const issued = new Date("2026-10-08T10:00:00Z");
    const { code } = await links.issueTelegramCode(user.id, issued);

    const later = new Date(issued.getTime() + 11 * 60_000);
    const result = await links.redeemTelegramCode({ code, externalId: "444" }, later);
    expect(result).toEqual({ ok: false, reason: "expired" });
  });

  it("refuses an unknown code", async () => {
    const result = await links.redeemTelegramCode({ code: "ZZZZZZZZ", externalId: "555" });
    expect(result).toEqual({ ok: false, reason: "invalid" });
  });

  it("never takes over a chat that belongs to another person, and keeps the code", async () => {
    const owner = await seedUser("holder@example.test");
    const other = await seedUser("intruder@example.test");
    const first = await links.issueTelegramCode(owner.id);
    await links.redeemTelegramCode({ code: first.code, externalId: "666" });

    const attempt = await links.issueTelegramCode(other.id);
    const result = await links.redeemTelegramCode({ code: attempt.code, externalId: "666" });
    expect(result).toEqual({ ok: false, reason: "taken" });
    expect(await links.resolveTelegramUser("666")).toBe(owner.id);

    // The refused code is not spent, so the person can still use it elsewhere.
    const row = await prisma.channelLinkCode.findUnique({
      where: { codeHash: links.hashCode(attempt.code) },
    });
    expect(row?.usedAt).toBeNull();
  });

  it("replaces the chat a person linked before", async () => {
    const user = await seedUser("relink@example.test");
    const a = await links.issueTelegramCode(user.id);
    await links.redeemTelegramCode({ code: a.code, externalId: "777" });
    const b = await links.issueTelegramCode(user.id);
    await links.redeemTelegramCode({ code: b.code, externalId: "888" });

    expect(await links.resolveTelegramUser("777")).toBeNull();
    expect(await links.resolveTelegramUser("888")).toBe(user.id);
  });

  it("unlinks and clears pending codes", async () => {
    const user = await seedUser("unlink@example.test");
    const a = await links.issueTelegramCode(user.id);
    await links.redeemTelegramCode({ code: a.code, externalId: "999" });
    await links.issueTelegramCode(user.id);

    await links.unlinkTelegram(user.id);
    expect(await links.telegramLinkFor(user.id)).toBeNull();
    expect(await links.resolveTelegramUser("999")).toBeNull();
    expect(await prisma.channelLinkCode.count({ where: { userId: user.id } })).toBe(0);
  });

  it("the signed-in action issues a code only to the person who asked", async () => {
    const user = await seedUser("action@example.test");
    viewer.current = { id: user.id, email: user.email };

    const state = await actions.startTelegramLink();
    expect(state.code).toMatch(/^[A-Z2-9]{8}$/);
    const result = await links.redeemTelegramCode({ code: state.code!, externalId: "1010" });
    expect(result).toEqual({ ok: true, userId: user.id });
  });
});

describe("channel endpoints", () => {
  it("refuses calls without the channel token", async () => {
    const res = await linkRoute.POST(
      post("/api/channels/telegram/link", { code: "ABCDEFGH", telegramUserId: "1" }, null),
    );
    expect(res.status).toBe(401);

    const res2 = await resolveRoute.POST(
      post("/api/channels/telegram/resolve", { telegramUserId: "1" }, "wrong"),
    );
    expect(res2.status).toBe(401);
  });

  it("links through the link endpoint and resolves through the resolve endpoint", async () => {
    const user = await seedUser("route@example.test");
    const { code } = await links.issueTelegramCode(user.id);

    const linked = await linkRoute.POST(
      post("/api/channels/telegram/link", { code, telegramUserId: "4242" }),
    );
    expect(linked.status).toBe(200);
    expect(await linked.json()).toEqual({ ok: true });

    const resolved = await resolveRoute.POST(
      post("/api/channels/telegram/resolve", { telegramUserId: "4242" }),
    );
    expect(resolved.status).toBe(200);
    expect(await resolved.json()).toEqual({ userId: user.id });
  });

  it("answers 404 for a chat that is not linked, and rejects malformed ids", async () => {
    const res = await resolveRoute.POST(
      post("/api/channels/telegram/resolve", { telegramUserId: "5555" }),
    );
    expect(res.status).toBe(404);

    const bad = await resolveRoute.POST(
      post("/api/channels/telegram/resolve", { telegramUserId: "not-a-number" }),
    );
    expect(bad.status).toBe(400);
  });
});
