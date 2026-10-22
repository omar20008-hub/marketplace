import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The long memory of a conversation: a running summary of the turns older than the
 * recent window, and a search over every past message on every channel, scoped to
 * the person.
 */

vi.mock("@/lib/n8n", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/n8n")>();
  return { ...actual, n8n: { ...actual.n8n, chat: async () => ({ output: "ok" }) } };
});

const { prisma } = await import("@/lib/db");
const memory = await import("@/server/conversation-memory");
const { withConversation, RECENT_TURNS } = await import("@/server/conversation");
const { POST: search } = await import("@/app/api/channels/conversation/search/route");

async function user(email: string) {
  await prisma.plan.upsert({
    where: { id: "cm-plan" },
    update: {},
    create: { id: "cm-plan", name: "T", monthlyRuns: 100, storageBytes: BigInt(1), monthlyCredits: 0 },
  });
  return prisma.user.create({ data: { email, name: "M", passwordHash: "x", initials: "M", planId: "cm-plan" } });
}

/** A thread with `count` alternating turns, a minute apart, oldest first. */
async function thread(userId: string, count: number, channel: string | null = null, text = (i: number) => `turn ${i}`) {
  const t = await prisma.thread.create({ data: { userId, title: channel ?? "t", channel } });
  const start = Date.now() - count * 60_000;
  for (let i = 0; i < count; i++) {
    await prisma.message.create({
      data: { threadId: t.id, role: i % 2 === 0 ? "USER" : "ASSISTANT", body: text(i), createdAt: new Date(start + i * 60_000) },
    });
  }
  return t;
}

async function wipe() {
  await prisma.message.deleteMany({});
  await prisma.thread.deleteMany({});
  await prisma.user.deleteMany({});
  await prisma.plan.deleteMany({});
}

beforeEach(async () => {
  await wipe();
  memory.conversationRuntime.summarize = vi.fn(async (previous: string, turns: { body: string }[]) =>
    [previous, ...turns.map((t) => t.body)].filter(Boolean).join(" | "),
  );
});
afterAll(async () => {
  await wipe();
  await prisma.$disconnect();
});

describe("the running summary", () => {
  it("waits until enough turns have left the recent window", async () => {
    const owner = await user("a@example.test");
    const t = await thread(owner.id, RECENT_TURNS + memory.SUMMARY_BATCH - 1);
    expect(await memory.summarizeIfDue(owner.id, t.id)).toBe(false);
    expect(memory.conversationRuntime.summarize).not.toHaveBeenCalled();
  });

  it("folds the older turns in, once, and travels in front of the next message", async () => {
    const owner = await user("a@example.test");
    const t = await thread(owner.id, RECENT_TURNS + memory.SUMMARY_BATCH);
    expect(await memory.summarizeIfDue(owner.id, t.id)).toBe(true);
    const saved = await prisma.thread.findUniqueOrThrow({ where: { id: t.id } });
    expect(saved.summary).toBe("turn 0 | turn 1 | turn 2 | turn 3 | turn 4 | turn 5");
    expect(saved.summaryUntil).not.toBeNull();

    // Nothing new has left the window: no second call.
    expect(await memory.summarizeIfDue(owner.id, t.id)).toBe(false);

    const input = await withConversation(owner.id, t.id, "next");
    expect(input).toContain("[ملخص ما سبق من المحادثة مع المستخدم");
    expect(input).toContain("turn 0 | turn 1");
    expect(input).toContain(`المساعد: turn ${RECENT_TURNS + memory.SUMMARY_BATCH - 1}`);
    expect(input).not.toContain("المستخدم: turn 0\n");
    expect(input.endsWith("next")).toBe(true);
  });

  it("builds on the previous summary", async () => {
    const owner = await user("a@example.test");
    const t = await thread(owner.id, RECENT_TURNS + memory.SUMMARY_BATCH);
    await memory.summarizeIfDue(owner.id, t.id);
    for (let i = 0; i < memory.SUMMARY_BATCH; i++) {
      await prisma.message.create({ data: { threadId: t.id, role: "USER", body: `later ${i}` } });
    }
    expect(await memory.summarizeIfDue(owner.id, t.id)).toBe(true);
    const saved = await prisma.thread.findUniqueOrThrow({ where: { id: t.id } });
    expect(saved.summary.startsWith("turn 0 | turn 1 | turn 2 | turn 3 | turn 4 | turn 5 | turn 6")).toBe(true);
  });

  it("is never another person's", async () => {
    const owner = await user("a@example.test");
    const other = await user("b@example.test");
    const t = await thread(owner.id, RECENT_TURNS + memory.SUMMARY_BATCH);
    expect(await memory.summarizeIfDue(other.id, t.id)).toBe(false);
  });
});

describe("searching the conversation", () => {
  it("finds a past message on any channel, and only the person's own", async () => {
    const owner = await user("a@example.test");
    const other = await user("b@example.test");
    await thread(owner.id, 4, "whatsapp", (i) => (i === 0 ? "apply to the Product Manager role at Scale in Riyadh" : `small talk ${i}`));
    await thread(owner.id, 2, null, () => "weather tomorrow");
    await thread(other.id, 2, null, () => "Product Manager role at Scale for someone else");

    const hits = await memory.searchConversation(owner.id, "Scale product manager role");
    expect(hits).toHaveLength(1);
    expect(hits[0]).toMatchObject({ role: "user", channel: "whatsapp" });
    expect(hits[0].text).toContain("Riyadh");
    expect(memory.formatHistory(hits)).toContain("· واتساب] المستخدم: apply to the Product Manager role");
    expect(memory.formatHistory([])).toContain("لا توجد");
  });

  it("indexes a thread's messages for search by meaning", async () => {
    const owner = await user("a@example.test");
    const t = await thread(owner.id, 3, null, (i) => `a message long enough to index ${i}`);
    expect(await memory.indexThread(owner.id, t.id)).toBe(3);
    expect(await memory.indexThread(owner.id, t.id)).toBe(0);
    expect(await prisma.messageEmbedding.count({ where: { userId: owner.id } })).toBe(3);
  });

  it("is open to n8n with the channel token only", async () => {
    const owner = await user("a@example.test");
    await thread(owner.id, 2, "whatsapp", () => "my passport expires in March");
    const post = (headers: Record<string, string>, body: unknown) =>
      search(new Request("http://localhost/x", { method: "POST", headers, body: JSON.stringify(body) }));

    expect((await post({}, { userId: owner.id, query: "passport" })).status).toBe(401);
    const res = await post({ "x-channel-token": "test-channel-token" }, { userId: `${owner.id}|whatsapp-1`, query: "passport expires" });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.results[0].text).toContain("passport");
    expect(body.text).toContain("passport");
  });
});
