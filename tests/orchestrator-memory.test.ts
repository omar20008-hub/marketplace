import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { prisma } from "@/lib/db";
import { MEMORY_WINDOW, recentTurns } from "@/server/orchestrator/memory";

/**
 * The Orchestrator's memory against the platform's own threads. Each case builds
 * its messages with explicit times, so the order the memory reads them in is the
 * order the test wrote them, not whatever the clock did.
 */

const PLAN_ID = "test-plan";
const BASE = Date.UTC(2026, 9, 20, 9, 0, 0);

async function wipe() {
  await prisma.message.deleteMany({});
  await prisma.thread.deleteMany({});
  await prisma.user.deleteMany({});
  await prisma.plan.deleteMany({});
}

async function makeUser(email: string) {
  await prisma.plan.upsert({
    where: { id: PLAN_ID },
    update: {},
    create: {
      id: PLAN_ID,
      name: "Test",
      monthlyRuns: 100,
      storageBytes: BigInt(1_000_000),
      monthlyCredits: 0,
    },
  });
  return prisma.user.create({
    data: { email, name: "Tester", passwordHash: "x", initials: "TE", planId: PLAN_ID },
  });
}

async function makeThread(userId: string) {
  return prisma.thread.create({ data: { userId, title: "محادثة" } });
}

async function say(threadId: string, index: number, role: "USER" | "ASSISTANT", body: string) {
  return prisma.message.create({
    data: { threadId, role, body, createdAt: new Date(BASE + index * 1000) },
  });
}

beforeEach(wipe);
afterAll(async () => {
  await wipe();
  await prisma.$disconnect();
});

describe("recentTurns", () => {
  it("returns the messages before the one being answered, oldest first", async () => {
    const user = await makeUser("memory-order@example.test");
    const thread = await makeThread(user.id);
    await say(thread.id, 0, "USER", "أول");
    await say(thread.id, 1, "ASSISTANT", "رد أول");
    const current = await say(thread.id, 2, "USER", "الحالي");

    const turns = await recentTurns({ userId: user.id, threadId: thread.id, beforeMessageId: current.id });

    expect(turns).toEqual([
      { role: "user", content: "أول" },
      { role: "assistant", content: "رد أول", toolCalls: [] },
    ]);
  });

  it("keeps only the last ten messages", async () => {
    const user = await makeUser("memory-window@example.test");
    const thread = await makeThread(user.id);
    for (let i = 0; i < 14; i++) {
      await say(thread.id, i, i % 2 === 0 ? "USER" : "ASSISTANT", `رسالة ${i}`);
    }
    const current = await say(thread.id, 14, "USER", "الحالية");

    const turns = await recentTurns({ userId: user.id, threadId: thread.id, beforeMessageId: current.id });

    expect(turns).toHaveLength(MEMORY_WINDOW);
    expect(turns[0].content).toBe("رسالة 4");
    expect(turns.at(-1)?.content).toBe("رسالة 13");
  });

  it("ignores messages written after the one being answered", async () => {
    const user = await makeUser("memory-later@example.test");
    const thread = await makeThread(user.id);
    const current = await say(thread.id, 0, "USER", "الحالي");
    await say(thread.id, 1, "ASSISTANT", "رد لاحق");

    const turns = await recentTurns({ userId: user.id, threadId: thread.id, beforeMessageId: current.id });

    expect(turns).toEqual([]);
  });

  it("gives no history for a thread that belongs to someone else", async () => {
    const owner = await makeUser("memory-owner@example.test");
    const other = await makeUser("memory-other@example.test");
    const thread = await makeThread(owner.id);
    await say(thread.id, 0, "USER", "سر");
    const current = await say(thread.id, 1, "USER", "الحالي");

    const turns = await recentTurns({ userId: other.id, threadId: thread.id, beforeMessageId: current.id });

    expect(turns).toEqual([]);
  });

  it("gives no history when the anchor is in a different thread", async () => {
    const user = await makeUser("memory-anchor@example.test");
    const first = await makeThread(user.id);
    const second = await makeThread(user.id);
    await say(first.id, 0, "USER", "في الأولى");
    const elsewhere = await say(second.id, 1, "USER", "في الثانية");

    const turns = await recentTurns({ userId: user.id, threadId: first.id, beforeMessageId: elsewhere.id });

    expect(turns).toEqual([]);
  });

  it("gives no history when the anchor does not exist", async () => {
    const user = await makeUser("memory-missing@example.test");
    const thread = await makeThread(user.id);
    await say(thread.id, 0, "USER", "موجودة");

    const turns = await recentTurns({
      userId: user.id,
      threadId: thread.id,
      beforeMessageId: "ckmissingmessage000000000",
    });

    expect(turns).toEqual([]);
  });
});
