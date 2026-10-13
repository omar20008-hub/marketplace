import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { sniffMedia, sniffVideo } from "@/lib/image-sniff";
import { mediaPreviews } from "@/components/app/linkified";

/**
 * Pictures and clips a workflow generates for a reply: what is accepted, that it
 * is stored under its owner, that the endpoint behind it needs the shared token,
 * and that the chat shows only this platform's own links.
 */

vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

const { prisma } = await import("@/lib/db");
const media = await import("@/server/media");
const { POST: receive } = await import("@/app/api/n8n/media/route");
const { GET: serve } = await import("@/app/api/media/[file]/route");

const PNG_BYTES = Uint8Array.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0x0d, 0x49, 0x48, 0x44, 0x52, 0, 0, 0, 1, 0, 0, 0, 1,
]);
const MP4_BYTES = Uint8Array.from([0, 0, 0, 0x18, 0x66, 0x74, 0x79, 0x70, 0x6d, 0x70, 0x34, 0x32, 0, 0, 0, 0]);
const WEBM_BYTES = Uint8Array.from([0x1a, 0x45, 0xdf, 0xa3, 0x01, 0x00, 0x00, 0x00, 0, 0, 0, 0]);
const TOKEN = process.env.N8N_SYNC_TOKEN!;

async function user(email: string) {
  await prisma.plan.upsert({
    where: { id: "gen-media-plan" },
    update: {},
    create: { id: "gen-media-plan", name: "T", monthlyRuns: 100, storageBytes: BigInt(1), monthlyCredits: 0 },
  });
  return prisma.user.create({
    data: { email, name: "G", passwordHash: "x", initials: "G", planId: "gen-media-plan" },
  });
}

function post(body: unknown, headers: Record<string, string> = { "x-sync-token": TOKEN }) {
  return receive(
    new Request("https://platform.example.test/api/n8n/media", {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify(body),
    }),
  );
}

beforeEach(async () => {
  await prisma.mediaUpload.deleteMany({});
  await prisma.user.deleteMany({});
  await prisma.plan.deleteMany({ where: { id: "gen-media-plan" } });
});
afterAll(async () => {
  await prisma.mediaUpload.deleteMany({});
  await prisma.user.deleteMany({});
  await prisma.plan.deleteMany({ where: { id: "gen-media-plan" } });
  await prisma.$disconnect();
});

describe("what is recognised as media", () => {
  it("tells MP4 and WebM apart from images and from anything else", () => {
    expect(sniffVideo(MP4_BYTES)).toEqual({ mime: "video/mp4", ext: "mp4" });
    expect(sniffVideo(WEBM_BYTES)).toEqual({ mime: "video/webm", ext: "webm" });
    expect(sniffMedia(PNG_BYTES)?.mime).toBe("image/png");
    expect(sniffVideo(Uint8Array.from([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]))).toBeNull();
  });
});

describe("saving generated media", () => {
  it("stores a clip for its owner and serves it back as video", async () => {
    const owner = await user("gen-owner@example.test");
    const saved = await media.saveGeneratedMedia(owner.id, "clip.mp4", MP4_BYTES);

    expect(saved.ok).toBe(true);
    if (!saved.ok) return;
    expect(saved.kind.mime).toBe("video/mp4");

    const response = await serve(new Request("https://x.test"), {
      params: Promise.resolve({ file: `${saved.token}.mp4` }),
    });
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("video/mp4");
  });

  it("keeps uploads to pictures: a clip cannot be attached in the chat", async () => {
    const result = await media.saveMedia((await user("gen-up@example.test")).id, "clip.mp4", MP4_BYTES);
    expect(result.ok).toBe(false);
  });

  it("refuses a file that is not a picture or a clip, whatever its name says", async () => {
    const owner = await user("gen-bad@example.test");
    const result = await media.saveGeneratedMedia(owner.id, "photo.png", Uint8Array.from([1, 2, 3, 4]));
    expect(result.ok).toBe(false);
  });

  it("refuses a clip over the limit", async () => {
    const owner = await user("gen-big@example.test");
    const huge = new Uint8Array(media.MAX_VIDEO_BYTES + 1);
    huge.set(MP4_BYTES, 0);
    const result = await media.saveGeneratedMedia(owner.id, "long.mp4", huge);
    expect(result.ok).toBe(false);
  });
});

describe("the endpoint a workflow posts to", () => {
  it("needs the shared token", async () => {
    const owner = await user("gen-auth@example.test");
    const response = await post(
      { userId: owner.id, name: "a.png", base64: Buffer.from(PNG_BYTES).toString("base64") },
      { "x-sync-token": "wrong" },
    );
    expect(response.status).toBe(401);
    expect(await prisma.mediaUpload.count()).toBe(0);
  });

  it("stores the bytes under the named user and answers with a link", async () => {
    const owner = await user("gen-ok@example.test");
    const response = await post({
      userId: owner.id,
      name: "image.png",
      base64: Buffer.from(PNG_BYTES).toString("base64"),
    });
    expect(response.status).toBe(201);
    const body = (await response.json()) as { url: string; mime: string };
    expect(body.mime).toBe("image/png");
    expect(body.url).toMatch(/\/api\/media\/[A-Za-z0-9_-]{43}\.png$/);
    expect(await prisma.mediaUpload.count({ where: { userId: owner.id } })).toBe(1);
  });

  it("refuses a user the platform does not know", async () => {
    const response = await post({
      userId: "nobody",
      name: "image.png",
      base64: Buffer.from(PNG_BYTES).toString("base64"),
    });
    expect(response.status).toBe(404);
  });
});

describe("what the chat shows", () => {
  it("shows this platform's pictures and clips, once each", () => {
    const token = "A".repeat(43);
    const text =
      `Here it is https://marketplace.example/api/media/${token}.png and again ` +
      `https://marketplace.example/api/media/${token}.png and a clip https://marketplace.example/api/media/${"B".repeat(43)}.mp4`;
    expect(mediaPreviews(text)).toEqual([
      { url: `https://marketplace.example/api/media/${token}.png`, kind: "image" },
      { url: `https://marketplace.example/api/media/${"B".repeat(43)}.mp4`, kind: "video" },
    ]);
  });

  it("leaves other links as plain links", () => {
    expect(mediaPreviews("see https://example.com/photo.png and https://x.test/api/media/short.png")).toEqual([]);
  });
});
