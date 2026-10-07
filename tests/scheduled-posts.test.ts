import { readFileSync } from "node:fs";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { prisma } from "@/lib/db";
import { n8n } from "@/lib/n8n";
import { mockDriver } from "@/lib/n8n/mock";
import { newKnowledgeKey } from "@/server/knowledge/keys";
import {
  cancelScheduledPost,
  createScheduledPost,
  parsePostInput,
  runDuePosts,
} from "@/server/posts/scheduled-posts";
import { DELETE } from "@/app/api/posts/[id]/route";
import { GET, POST } from "@/app/api/posts/route";

/**
 * The Post Scheduler's queue: what it refuses, who may touch a post, and that a
 * due post is published once. The publishing itself happens in the user's n8n
 * instance, so the mock driver stands in for it.
 */

const NOW = new Date("2026-10-10T08:00:00.000Z");
const IN_AN_HOUR = "2026-10-10T09:00:00.000Z";
const PLAN_ID = "test-plan-posts";

async function wipe() {
  await prisma.scheduledPost.deleteMany({});
  await prisma.artifact.deleteMany({});
  await prisma.runStep.deleteMany({});
  await prisma.run.deleteMany({});
  await prisma.installationCredential.deleteMany({});
  await prisma.installation.deleteMany({});
  await prisma.requirement.deleteMany({});
  await prisma.connectedAccount.deleteMany({});
  await prisma.product.deleteMany({});
  await prisma.user.deleteMany({});
  await prisma.plan.deleteMany({});
}

async function seedInstallation(email: string) {
  await prisma.plan.upsert({
    where: { id: PLAN_ID },
    update: {},
    create: { id: PLAN_ID, name: "Test", monthlyRuns: 100, storageBytes: BigInt(1_000_000), monthlyCredits: 0 },
  });
  const user = await prisma.user.create({
    data: { email, name: "P", passwordHash: "x", initials: "P", planId: PLAN_ID },
  });
  const product = await prisma.product.create({
    data: {
      slug: `p-${Math.random().toString(36).slice(2, 8)}`,
      creatorId: user.id,
      title: "Post scheduler",
      summary: "s",
      description: "d",
      needsFromYou: "n",
      kind: "WORKFLOW",
      category: "Social",
      status: "PUBLISHED",
      inputSchema: [
        { name: "caption", label: "Caption", type: "string" },
        { name: "networks", label: "Networks", type: "string" },
        { name: "scheduledAt", label: "When", type: "string" },
        { name: "mediaUrl", label: "Image", type: "string" },
        { name: "postId", label: "Post", type: "string" },
      ] as never,
    },
  });
  const { key, hash } = newKnowledgeKey();
  const installation = await prisma.installation.create({
    data: {
      userId: user.id,
      productId: product.id,
      pinnedVersion: "1.0",
      status: "ACTIVE",
      installationId: `inst_${Math.random().toString(36).slice(2, 8)}`,
      knowledgeKeyHash: hash,
    },
  });
  return { user, installation, key };
}

const valid = {
  caption: "Launch day",
  networks: "facebook,instagram",
  mediaUrl: "https://cdn.example.test/a.jpg",
  scheduledAt: IN_AN_HOUR,
};

const request = (key: string | null, body?: unknown, method = "POST") =>
  new Request("http://localhost/api/posts", {
    method,
    headers: { ...(key ? { authorization: `Bearer ${key}` } : {}), "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

beforeEach(wipe);
afterAll(async () => {
  await wipe();
  await prisma.$disconnect();
});

describe("parsePostInput", () => {
  it("accepts a complete post", () => {
    const parsed = parsePostInput(valid, NOW);
    expect(parsed).toMatchObject({ ok: true, value: { networks: ["facebook", "instagram"] } });
  });

  it.each([
    [{ ...valid, caption: " " }, /caption/],
    [{ ...valid, networks: "" }, /networks/],
    [{ ...valid, networks: "facebook,tiktok" }, /tiktok/],
    [{ ...valid, mediaUrl: "http://cdn.example.test/a.jpg" }, /https/],
    [{ ...valid, mediaUrl: undefined }, /Instagram/],
    [{ ...valid, pageId: "abc" }, /pageId/],
    [{ ...valid, scheduledAt: "tomorrow" }, /ISO 8601/],
    [{ ...valid, scheduledAt: "2026-10-10T08:00:30.000Z" }, /minute in the future/],
    [{ ...valid, scheduledAt: "2027-06-01T00:00:00.000Z" }, /75 days/],
    [{ ...valid, caption: "x".repeat(2201) }, /2200/],
  ])("refuses %#", (body, reason) => {
    const parsed = parsePostInput(body, NOW);
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.error).toMatch(reason);
  });

  it("reads the word none as no image", () => {
    expect(parsePostInput({ ...valid, networks: "facebook", mediaUrl: "none" }, NOW)).toMatchObject({
      ok: true,
      value: { mediaUrl: null },
    });
    expect(parsePostInput({ ...valid, mediaUrl: "None" }, NOW)).toMatchObject({
      ok: false,
      error: expect.stringMatching(/Instagram/),
    });
  });

  it("lets a Facebook-only post go without an image", () => {
    expect(parsePostInput({ ...valid, networks: "facebook", mediaUrl: undefined }, NOW).ok).toBe(true);
  });
});

describe("/api/posts", () => {
  it("answers 401 without a valid installation key", async () => {
    expect((await POST(request(null, valid))).status).toBe(401);
    expect((await POST(request("kb_" + "x".repeat(40), valid))).status).toBe(401);
    expect((await GET(request(null, undefined, "GET"))).status).toBe(401);
  });

  it("queues a post and lists only this installation's", async () => {
    const mine = await seedInstallation("a@example.test");
    const other = await seedInstallation("b@example.test");
    const future = new Date(Date.now() + 3_600_000).toISOString();

    const created = await POST(request(mine.key, { ...valid, scheduledAt: future }));
    expect(created.status).toBe(201);
    await POST(request(other.key, { ...valid, scheduledAt: future }));

    const listed = await (await GET(request(mine.key, undefined, "GET"))).json();
    expect(listed.posts).toHaveLength(1);
    expect(listed.posts[0]).toMatchObject({ status: "SCHEDULED", networks: ["facebook", "instagram"] });
  });

  it("explains a refusal in a sentence", async () => {
    const { key } = await seedInstallation("a@example.test");
    const reply = await POST(request(key, { ...valid, scheduledAt: "2020-01-01T00:00:00Z" }));
    expect(reply.status).toBe(400);
    expect((await reply.json()).error).toMatch(/future/);
  });

  it("cancels only its own scheduled post", async () => {
    const mine = await seedInstallation("a@example.test");
    const other = await seedInstallation("b@example.test");
    const post = await createScheduledPost(mine.installation.id, {
      caption: "c", networks: ["facebook"], mediaUrl: null, pageId: null, scheduledAt: new Date(Date.now() + 3_600_000),
    });
    const params = { params: Promise.resolve({ id: post.id }) };

    expect((await DELETE(request(other.key, undefined, "DELETE"), params)).status).toBe(404);
    expect((await DELETE(request(mine.key, undefined, "DELETE"), params)).status).toBe(200);
    expect((await DELETE(request(mine.key, undefined, "DELETE"), params)).status).toBe(404);
    expect(await cancelScheduledPost(mine.installation.id, post.id)).toBe(false);
  });
});

describe("runDuePosts", () => {
  const make = (installationId: string, scheduledAt: Date, extra = {}) =>
    createScheduledPost(installationId, {
      caption: "Hello", networks: ["facebook"], mediaUrl: null, pageId: null, scheduledAt, ...extra,
    });

  it("publishes a due post once and leaves a future one alone", async () => {
    const { installation } = await seedInstallation("a@example.test");
    const due = await make(installation.id, new Date("2026-10-10T07:59:00Z"));
    const later = await make(installation.id, new Date("2026-10-10T10:00:00Z"));

    const first = await runDuePosts({ now: NOW });
    expect(first.outcomes).toEqual([{ postId: due.id, status: "PUBLISHED" }]);

    const second = await runDuePosts({ now: NOW });
    expect(second.checked).toBe(0);

    expect(await prisma.scheduledPost.findUnique({ where: { id: due.id } })).toMatchObject({
      status: "PUBLISHED", attempts: 1,
    });
    expect((await prisma.scheduledPost.findUnique({ where: { id: later.id } }))?.status).toBe("SCHEDULED");
  });

  it("hands the workflow the post, with its id, so it takes the publishing path", async () => {
    const { installation } = await seedInstallation("a@example.test");
    const post = await make(installation.id, new Date("2026-10-10T07:59:00Z"), {
      networks: ["facebook", "instagram"], mediaUrl: "https://cdn.example.test/a.jpg",
    });
    await runDuePosts({ now: NOW });
    const row = await prisma.scheduledPost.findUnique({ where: { id: post.id } });
    const received = JSON.parse(row?.result ?? "{}").received;
    expect(received).toMatchObject({ postId: post.id, networks: "facebook,instagram", caption: "Hello" });
  });

  it("sends every declared input, with the word none for a post without an image", async () => {
    const { installation } = await seedInstallation("a@example.test");
    const post = await make(installation.id, new Date("2026-10-10T07:59:00Z"));
    await runDuePosts({ now: NOW });
    // The mock enforces the real dispatcher's rule: a missing or empty declared input is "incomplete".
    const row = await prisma.scheduledPost.findUnique({ where: { id: post.id } });
    expect(row?.status).toBe("PUBLISHED");
    expect(JSON.parse(row?.result ?? "{}").received).toMatchObject({ mediaUrl: "none", postId: post.id });
  });

  it("does not publish a cancelled post", async () => {
    const { installation } = await seedInstallation("a@example.test");
    const post = await make(installation.id, new Date("2026-10-10T07:59:00Z"));
    await cancelScheduledPost(installation.id, post.id);
    expect((await runDuePosts({ now: NOW })).checked).toBe(0);
  });

  it("records a failure on the post and never retries it", async () => {
    const { installation } = await seedInstallation("a@example.test");
    await prisma.installation.update({ where: { id: installation.id }, data: { status: "DISABLED" } });
    const post = await make(installation.id, new Date("2026-10-10T07:59:00Z"));

    await runDuePosts({ now: NOW });
    const row = await prisma.scheduledPost.findUnique({ where: { id: post.id } });
    expect(row?.status).toBe("FAILED");
    expect(row?.result).toBeTruthy();

    expect((await runDuePosts({ now: NOW })).checked).toBe(0);
  });

  it("keeps the reason the workflow gave when a publish fails", async () => {
    const { installation } = await seedInstallation("a@example.test");
    const post = await make(installation.id, new Date("2026-10-10T07:59:00Z"));
    const dispatch = vi
      .spyOn(n8n, "dispatch")
      .mockResolvedValueOnce({ result: "error", errorType: "فيسبوك رفض الطلب: Invalid OAuth access token" });

    await runDuePosts({ now: NOW });

    const row = await prisma.scheduledPost.findUnique({ where: { id: post.id } });
    expect(row?.status).toBe("FAILED");
    expect(row?.result).toBe("Failed · فيسبوك رفض الطلب: Invalid OAuth access token");
    dispatch.mockRestore();
  });

  it("marks a post abandoned mid-publish as failed instead of sending it again", async () => {
    const { installation } = await seedInstallation("a@example.test");
    const post = await make(installation.id, new Date("2026-10-10T07:00:00Z"));
    await prisma.scheduledPost.update({
      where: { id: post.id },
      data: { status: "PUBLISHING", claimedAt: new Date("2026-10-10T07:30:00Z") },
    });
    const { checked } = await runDuePosts({ now: NOW });
    expect(checked).toBe(0);
    expect((await prisma.scheduledPost.findUnique({ where: { id: post.id } }))?.status).toBe("FAILED");
  });

  it("lets two overlapping ticks publish a post only once", async () => {
    const { installation } = await seedInstallation("a@example.test");
    await make(installation.id, new Date("2026-10-10T07:59:00Z"));
    const [a, b] = await Promise.all([runDuePosts({ now: NOW }), runDuePosts({ now: NOW })]);
    const published = [...a.outcomes, ...b.outcomes].filter((o) => o.status === "PUBLISHED");
    expect(published).toHaveLength(1);
  });
});

describe("the template", () => {
  it("is accepted as an on-demand product that needs only a Facebook connection", async () => {
    const reply = await mockDriver.upload({
      creatorId: "c", title: "Post scheduler", description: "d", actionType: "write",
      file: readFileSync("templates/post-scheduler.json", "utf8"),
    });
    expect(reply).toMatchObject({
      invocationMode: "on_demand",
      requiredCredentials: "facebookGraphApi",
      credentialDurability: "durable",
      inputFields: "caption,networks,scheduledAt,mediaUrl,postId",
    });
  });

  it("lets a Facebook error come back as data, so its own message reaches the owner", () => {
    const template = JSON.parse(readFileSync("templates/post-scheduler.json", "utf8")) as {
      nodes: { name: string; parameters: { options?: unknown; jsCode?: string } }[];
    };
    const node = (name: string) => template.nodes.find((n) => n.name === name)!;
    for (const name of ["Get Pages", "Publish Facebook", "Create IG Container", "Publish IG"]) {
      expect(JSON.stringify(node(name).parameters.options)).toContain('"neverError":true');
    }
    expect(node("Pick Page").parameters.jsCode).toContain("answer.error.message");
  });

  it("calls the platform with the placeholders MP · Install Template fills in", () => {
    const text = readFileSync("templates/post-scheduler.json", "utf8");
    expect(text).toContain("__MP_PLATFORM_URL__/api/posts");
    expect(text).toContain("Bearer __MP_KNOWLEDGE_KEY__");
  });
});

describe("postsActivity", () => {
  const at = (iso: string, status = "SCHEDULED") => ({ status, scheduledAt: new Date(iso) });
  const now = new Date("2026-10-10T08:00:00Z").getTime();

  it("is quiet for a post that is hours away", async () => {
    const { postsActivity } = await import("@/lib/posts");
    expect(postsActivity([at("2026-10-10T12:00:00Z")], now)).toEqual({ stalled: false, busy: false });
  });

  it("refreshes for a post that is due within a minute, or publishing", async () => {
    const { postsActivity } = await import("@/lib/posts");
    expect(postsActivity([at("2026-10-10T08:00:30Z")], now).busy).toBe(true);
    expect(postsActivity([at("2026-10-10T07:00:00Z", "PUBLISHING")], now).busy).toBe(true);
  });

  it("says the clock is stopped only for a post long past due", async () => {
    const { postsActivity } = await import("@/lib/posts");
    expect(postsActivity([at("2026-10-10T07:58:00Z")], now).stalled).toBe(false);
    expect(postsActivity([at("2026-10-10T07:50:00Z")], now).stalled).toBe(true);
    expect(postsActivity([at("2026-10-10T07:50:00Z", "PUBLISHED")], now).stalled).toBe(false);
  });
});

describe("what upload marks", () => {
  it("flags the template as posts, not as files", async () => {
    const text = readFileSync("templates/post-scheduler.json", "utf8");
    expect(text.includes("__MP_KNOWLEDGE_KEY__") && text.includes("/api/posts")).toBe(true);
    expect(text.includes("/api/knowledge/")).toBe(false);
  });
});
