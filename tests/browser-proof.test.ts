import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * What the assistant's browser saw goes to the person with the reply: the browser's service uploads a picture
 * with the person's agent key, and n8n collects it from an outbox after it sends the answer on WhatsApp.
 */

vi.mock("server-only", () => ({}));
vi.mock("@/lib/auth", () => ({ currentUser: async () => null }));

const { prisma } = await import("@/lib/db");
const { issueAgentKey } = await import("@/server/agent-keys");
const { POST: upload } = await import("@/app/api/agent/proof/route");
const { POST: outbox } = await import("@/app/api/channels/whatsapp/outbox/route");
const { GET: serve } = await import("@/app/api/media/[file]/route");

const PLAN_ID = "test-plan-proof";
const NUMBER = "966500000111";
const JPEG = Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4, 5, 6]);
const PNG = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0x0d, 0x49, 0x48, 0x44, 0x52, 0, 0, 0, 1, 0, 0, 0, 1]);

async function person(email: string, linked = true) {
  await prisma.plan.upsert({
    where: { id: PLAN_ID },
    create: { id: PLAN_ID, name: "T", monthlyRuns: 10, storageBytes: BigInt(1000), monthlyCredits: 0 },
    update: {},
  });
  const user = await prisma.user.create({
    data: { email, name: "P", passwordHash: "x", initials: "P", planId: PLAN_ID },
    select: { id: true },
  });
  if (linked) await prisma.channelLink.create({ data: { userId: user.id, channel: "whatsapp", externalId: NUMBER } });
  return user;
}

const send = (key: string | null, bytes: Uint8Array, caption = "") =>
  upload(
    new Request("http://localhost/api/agent/proof", {
      method: "POST",
      headers: { ...(key ? { authorization: `Bearer ${key}` } : {}), "x-caption": encodeURIComponent(caption) },
      body: bytes as unknown as BodyInit,
    }),
  );

const collect = (number = NUMBER, token: string | null = "test-channel-token") =>
  outbox(
    new Request("https://example.test/api/channels/whatsapp/outbox", {
      method: "POST",
      headers: { "content-type": "application/json", ...(token ? { "x-channel-token": token } : {}) },
      body: JSON.stringify({ whatsappUserId: number }),
    }),
  );

async function wipe() {
  await prisma.mediaUpload.deleteMany({});
  await prisma.agentKey.deleteMany({});
  await prisma.channelLink.deleteMany({});
  await prisma.user.deleteMany({});
  await prisma.plan.deleteMany({});
}

beforeEach(wipe);
afterAll(async () => {
  await wipe();
  await prisma.$disconnect();
});

describe("a picture of the page, from the browser's service to the person's WhatsApp", () => {
  it("is uploaded with the person's key, handed out once with a link WhatsApp can fetch, and served as the image it is", async () => {
    const owner = await person("a@example.test");
    const key = await issueAgentKey(owner.id);
    expect((await send(key, JPEG, "Thank you for applying")).status).toBe(201);

    const first = await (await collect()).json();
    expect(first.items).toHaveLength(1);
    expect(first.items[0].caption).toBe("Thank you for applying");
    // The address comes from PUBLIC_URL, never from the request (behind the proxy that would be 0.0.0.0).
    expect(first.items[0].url).toMatch(/^https:\/\/app\.example\.test\/api\/media\/[A-Za-z0-9_-]{43}\.jpg$/);

    const file = first.items[0].url.split("/api/media/")[1];
    const image = await serve(new Request(first.items[0].url), { params: Promise.resolve({ file }) });
    expect(image.status).toBe(200);
    expect(image.headers.get("content-type")).toBe("image/jpeg");
    expect(new Uint8Array(await image.arrayBuffer())).toEqual(JPEG);

    expect((await (await collect()).json()).items).toEqual([]);             // each picture is handed out once
    const wrong = file.replace(/^./, file[0] === "A" ? "B" : "A");
    expect((await serve(new Request("https://x"), { params: Promise.resolve({ file: wrong }) })).status).toBe(404);
  });

  it("handles a PNG, the newest three at most, in the order they were taken", async () => {
    const owner = await person("a@example.test");
    const key = await issueAgentKey(owner.id);
    for (const caption of ["one", "two", "three", "four"]) {
      await send(key, caption === "four" ? PNG : JPEG, caption);
      await new Promise((r) => setTimeout(r, 5));
    }
    const { items } = await (await collect()).json();
    expect(items.map((i: { caption: string }) => i.caption)).toEqual(["two", "three", "four"]);
    expect(items[2].url).toMatch(/\.png$/);
  });

  it("keeps one person's pictures from another, and drops old ones", async () => {
    const owner = await person("a@example.test");
    const key = await issueAgentKey(owner.id);
    await send(key, JPEG, "mine");
    await prisma.mediaUpload.updateMany({ data: { createdAt: new Date(Date.now() - 20 * 60 * 1000) } });
    expect((await (await collect()).json()).items).toEqual([]);              // older than the 15 minute window

    await send(key, JPEG, "fresh");
    const other = await person("b@example.test", false);
    await prisma.channelLink.create({ data: { userId: other.id, channel: "whatsapp", externalId: "966500000222" } });
    expect((await (await collect("966500000222")).json()).items).toEqual([]);     // not their picture
    expect((await (await collect()).json()).items.map((i: { caption: string }) => i.caption)).toEqual(["fresh"]);
  });

  it("is kept three days only", async () => {
    const owner = await person("a@example.test");
    await send(await issueAgentKey(owner.id), JPEG, "x");
    const row = await prisma.mediaUpload.findFirstOrThrow({});
    const days = (row.expiresAt.getTime() - row.createdAt.getTime()) / 86_400_000;
    expect(days).toBeGreaterThan(2.9);
    expect(days).toBeLessThan(3.1);
  });

  it("refuses what is not a picture, a missing or unknown key, and the outbox without the channel token", async () => {
    const owner = await person("a@example.test");
    const key = await issueAgentKey(owner.id);
    expect((await send(null, JPEG)).status).toBe(401);
    expect((await send("ak_unknown", JPEG)).status).toBe(401);
    expect((await send(key, new TextEncoder().encode("not an image"))).status).toBe(400);
    expect((await send(key, new Uint8Array(0))).status).toBe(400);
    expect((await collect(NUMBER, null)).status).toBe(401);
    expect((await collect(NUMBER, "wrong")).status).toBe(401);
    expect((await collect("not-a-number")).status).toBe(400);
    expect((await collect("966599999999")).status).toBe(404);
  });
});
