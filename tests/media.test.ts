import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { sniffImage } from "@/lib/image-sniff";

/**
 * Images attached in the chat: what is accepted, who may see it, who may use it,
 * and that the assistant is told only about links that really are the user's own.
 */

const viewer = vi.hoisted(() => ({ current: null as { id: string; plan?: unknown } | null }));
vi.mock("@/lib/auth", () => ({
  currentUser: async () => viewer.current,
  requireUser: async () => {
    if (!viewer.current) throw new Error("redirect:/login");
    return viewer.current;
  },
}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("next/navigation", () => ({
  redirect: (to: string) => {
    throw new Error(`redirect:${to}`);
  },
}));
const chatCalls: { sessionId: string; chatInput: string }[] = [];
vi.mock("@/lib/n8n", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/n8n")>();
  return {
    ...actual,
    n8n: {
      ...actual.n8n,
      chat: async (input: { sessionId: string; chatInput: string }) => {
        chatCalls.push(input);
        return { output: "ok" };
      },
    },
  };
});

const { prisma } = await import("@/lib/db");
const media = await import("@/server/media");
const { POST: upload } = await import("@/app/api/media/route");
const { GET: serve } = await import("@/app/api/media/[file]/route");
const { followUp } = await import("@/server/thread-actions");
const { parsePostInput } = await import("@/server/posts/scheduled-posts");

const JPEG = Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, 0, 0x10, 0x4a, 0x46, 0x49, 0x46, 0, 1]);
const PNG = Uint8Array.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0x0d, 0x49, 0x48, 0x44, 0x52, 0, 0, 0, 1, 0, 0, 0, 1,
]);

async function user(email: string) {
  await prisma.plan.upsert({
    where: { id: "media-plan" },
    update: {},
    create: { id: "media-plan", name: "T", monthlyRuns: 100, storageBytes: BigInt(1), monthlyCredits: 0 },
  });
  return prisma.user.create({
    data: { email, name: "M", passwordHash: "x", initials: "M", planId: "media-plan" },
  });
}

const form = (bytes: Uint8Array, name = "pic.jpg", type = "image/jpeg") => {
  const body = new FormData();
  body.set("file", new File([Buffer.from(bytes)], name, { type }));
  return new Request("http://localhost/api/media", { method: "POST", body });
};

async function uploadAs(owner: { id: string }, bytes = JPEG, name = "pic.jpg") {
  viewer.current = owner;
  const reply = await upload(form(bytes, name));
  expect(reply.status).toBe(201);
  return (await reply.json()) as { url: string; name: string; mime: string };
}

async function wipe() {
  await prisma.mediaUpload.deleteMany({});
  await prisma.message.deleteMany({});
  await prisma.thread.deleteMany({});
  await prisma.user.deleteMany({});
  await prisma.plan.deleteMany({});
}

beforeEach(async () => {
  viewer.current = null;
  chatCalls.length = 0;
  await wipe();
});
afterAll(async () => {
  await wipe();
  await prisma.$disconnect();
});

describe("sniffImage", () => {
  it("knows a JPEG and a PNG by their first bytes", () => {
    expect(sniffImage(JPEG)?.mime).toBe("image/jpeg");
    expect(sniffImage(PNG)?.mime).toBe("image/png");
  });

  it.each([
    ["text", new TextEncoder().encode("<svg onload=alert(1)>")],
    ["a GIF", new TextEncoder().encode("GIF89a......")],
    ["a PNG with no header chunk", Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3])],
    ["nothing", new Uint8Array()],
  ])("refuses %s", (_label, bytes) => {
    expect(sniffImage(bytes)).toBeNull();
  });
});

describe("POST /api/media", () => {
  it("needs a signed-in user", async () => {
    expect((await upload(form(JPEG))).status).toBe(401);
  });

  it("stores a JPEG and hands back a link that serves it", async () => {
    const owner = await user("a@example.test");
    const { url, mime } = await uploadAs(owner);
    expect(mime).toBe("image/jpeg");
    expect(url).toMatch(/\/api\/media\/[A-Za-z0-9_-]{43}\.jpg$/);

    // No session: the link itself is the credential, as it is for Instagram's servers.
    viewer.current = null;
    const reply = await serve(new Request(url), { params: Promise.resolve({ file: new URL(url).pathname.split("/").pop()! }) });
    expect(reply.status).toBe(200);
    expect(reply.headers.get("content-type")).toBe("image/jpeg");
    expect(reply.headers.get("x-content-type-options")).toBe("nosniff");
    expect([...new Uint8Array(await reply.arrayBuffer())]).toEqual([...JPEG]);
  });

  it("believes the bytes, not the name or the declared type", async () => {
    viewer.current = await user("a@example.test");
    const html = new TextEncoder().encode("<script>alert(1)</script>");
    const reply = await upload(form(html, "evil.png", "image/png"));
    expect(reply.status).toBe(400);
    expect((await reply.json()).error).toMatch(/JPEG and PNG/);

    const stored = await upload(form(PNG, "photo.jpg", "image/jpeg"));
    expect((await stored.json()).mime).toBe("image/png");
  });

  it("refuses an image over 8 MB", async () => {
    viewer.current = await user("a@example.test");
    const big = new Uint8Array(media.MAX_IMAGE_BYTES + 1);
    big.set(JPEG);
    expect((await upload(form(big))).status).toBe(400);
  });

  it("keeps only a harmless label of the file's name", async () => {
    const owner = await user("a@example.test");
    const { name } = await uploadAs(owner, JPEG, "../../etc/pass<wd>.jpg");
    expect(name).toBe("pass_wd_.jpg");
  });
});

describe("serving", () => {
  it("answers 404 for an unknown link, a wrong extension and an expired image", async () => {
    const owner = await user("a@example.test");
    const { url } = await uploadAs(owner);
    const file = new URL(url).pathname.split("/").pop()!;
    const get = (f: string) => serve(new Request(url), { params: Promise.resolve({ file: f }) });

    expect((await get("x".repeat(43) + ".jpg")).status).toBe(404);
    expect((await get(file.replace(".jpg", ".png"))).status).toBe(404);
    expect((await get("not-a-token")).status).toBe(404);

    await prisma.mediaUpload.updateMany({ data: { expiresAt: new Date(Date.now() - 1000) } });
    expect((await get(file)).status).toBe(404);
    expect(await media.purgeExpiredMedia()).toBe(1);
  });
});

describe("resolveAttachments", () => {
  it("keeps this user's own links and drops everything else", async () => {
    const mine = await user("a@example.test");
    const other = await user("b@example.test");
    const own = await uploadAs(mine);
    const theirs = await uploadAs(other);

    const resolved = await media.resolveAttachments(mine.id, [
      own.url,
      theirs.url, // someone else's image
      "https://evil.example/photo.jpg", // not ours at all
      "javascript:alert(1)",
      "not a url",
    ]);
    expect(resolved.map((a) => a.url)).toEqual([own.url]);
  });

  it("describes them for the person and for the assistant", async () => {
    const owner = await user("a@example.test");
    const { url } = await uploadAs(owner, PNG);
    const text = media.describeAttachments(await media.resolveAttachments(owner.id, [url]));
    expect(text.shown).toBe(`Attached image: ${url}`);
    expect(text.forAssistant).toContain(`${url} (PNG)`);
    expect(text.forAssistant).toContain("mediaUrl");
  });
});

describe("followUp with an attachment", () => {
  it("shows the link in the thread and tells the assistant to use it as the image", async () => {
    const owner = await user("a@example.test");
    const { url } = await uploadAs(owner);
    const thread = await prisma.thread.create({ data: { userId: owner.id, title: "t" } });

    const body = new FormData();
    body.set("threadId", thread.id);
    body.set("message", "post this tomorrow at 9");
    body.append("attachment", url);
    body.append("attachment", "https://evil.example/x.jpg");
    await followUp(body);

    const stored = await prisma.message.findFirstOrThrow({ where: { threadId: thread.id, role: "USER" } });
    expect(stored.body).toBe(`post this tomorrow at 9\n\nAttached image: ${url}`);
    expect(chatCalls).toHaveLength(1);
    expect(chatCalls[0].chatInput).toContain(url);
    expect(chatCalls[0].chatInput).not.toContain("evil.example");
  });
});

describe("Instagram needs a JPEG", () => {
  const base = { caption: "c", networks: "instagram", scheduledAt: new Date(Date.now() + 3_600_000).toISOString() };

  it("refuses a PNG link for Instagram, but not for Facebook", () => {
    const png = "https://cdn.example.test/api/media/abc.png";
    expect(parsePostInput({ ...base, mediaUrl: png })).toMatchObject({ ok: false, error: expect.stringMatching(/JPEG/) });
    expect(parsePostInput({ ...base, networks: "facebook", mediaUrl: png }).ok).toBe(true);
    expect(parsePostInput({ ...base, mediaUrl: "https://cdn.example.test/api/media/abc.jpg" }).ok).toBe(true);
  });
});
