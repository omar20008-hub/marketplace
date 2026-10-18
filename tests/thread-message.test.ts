import { afterAll, describe, expect, it } from "vitest";

/**
 * A workflow that finishes after the chat reply has gone out writes its result into the
 * thread the request came from. The caller must hold an installation key of the same
 * user the session names; nothing else may write into a thread.
 */

const { prisma } = await import("@/lib/db");
const { newKnowledgeKey } = await import("@/server/knowledge/keys");
const { POST: deliver } = await import("@/app/api/n8n/thread-message/route");

const RUN = Math.random().toString(36).slice(2, 8);

// This file's own users and products, removed in the order the foreign keys need. A
// product left behind would otherwise block the blanket user cleanup of later files.
afterAll(async () => {
  const owners = (await prisma.user.findMany({ where: { email: { contains: RUN } }, select: { id: true } })).map(
    (owner) => owner.id,
  );
  await prisma.installation.deleteMany({ where: { product: { creatorId: { in: owners } } } });
  await prisma.product.deleteMany({ where: { creatorId: { in: owners } } });
  await prisma.user.deleteMany({ where: { id: { in: owners } } });
});

async function setup(label: string) {
  await prisma.plan.upsert({
    where: { id: "thread-message-plan" },
    update: {},
    create: { id: "thread-message-plan", name: "T", monthlyRuns: 100, storageBytes: BigInt(1), monthlyCredits: 0 },
  });
  const owner = await prisma.user.create({
    data: {
      email: `thread-message-${label}-${RUN}@example.test`,
      name: "T",
      passwordHash: "x",
      initials: "T",
      planId: "thread-message-plan",
    },
  });
  const product = await prisma.product.create({
    data: {
      slug: `thread-message-${label}-${RUN}`,
      creatorId: owner.id,
      title: "T",
      summary: "s",
      description: "d",
      needsFromYou: "",
      kind: "WORKFLOW",
      category: "c",
      status: "PUBLISHED",
      templateId: `tpl_tm_${label}_${RUN}`,
    },
  });
  const { key, hash } = newKnowledgeKey();
  await prisma.installation.create({
    data: {
      installationId: `inst_tm_${label}_${RUN}`,
      userId: owner.id,
      productId: product.id,
      pinnedVersion: "1",
      instanceWorkflowId: "wf",
      storageBackend: "platform",
      status: "ACTIVE",
      knowledgeKeyHash: hash,
    },
  });
  const thread = await prisma.thread.create({ data: { userId: owner.id, title: "Chat" } });
  return { owner, thread, key };
}

function post(body: unknown, key?: string) {
  return deliver(
    new Request("https://platform.example.test/api/n8n/thread-message", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(key ? { authorization: `Bearer ${key}` } : {}),
      },
      body: JSON.stringify(body),
    }),
  );
}

describe("POST /api/n8n/thread-message", () => {
  it("adds the text to the thread the session names, as an assistant message", async () => {
    const { owner, thread, key } = await setup("ok");
    const response = await post(
      { sessionId: `${owner.id}|${thread.id}`, text: "MEDIA: https://example.test/x.mp4" },
      key,
    );
    expect(response.status).toBe(201);
    const message = await prisma.message.findFirst({ where: { threadId: thread.id } });
    expect(message!.role).toBe("ASSISTANT");
    expect(message!.body).toBe("MEDIA: https://example.test/x.mp4");
  });

  it("refuses without an installation key", async () => {
    const { owner, thread } = await setup("nokey");
    const response = await post({ sessionId: `${owner.id}|${thread.id}`, text: "x" });
    expect(response.status).toBe(401);
    expect(await prisma.message.count({ where: { threadId: thread.id } })).toBe(0);
  });

  it("refuses a session that names another user's thread", async () => {
    const mine = await setup("victim");
    const other = await setup("attacker");
    const response = await post(
      { sessionId: `${other.owner.id}|${mine.thread.id}`, text: "x" },
      other.key,
    );
    // Not found, rather than forbidden: a thread that is not this user's is not
    // revealed to them at all.
    expect(response.status).toBe(404);
    expect(await prisma.message.count({ where: { threadId: mine.thread.id } })).toBe(0);
  });

  it("refuses a session naming a thread that is not the owner's", async () => {
    const { owner, key } = await setup("unknown");
    const response = await post({ sessionId: `${owner.id}|missing-thread`, text: "x" }, key);
    expect(response.status).toBe(404);
  });

  it("refuses a malformed session id", async () => {
    const { key } = await setup("bad");
    const response = await post({ sessionId: "just-a-user", text: "x" }, key);
    expect(response.status).toBe(400);
  });
});
