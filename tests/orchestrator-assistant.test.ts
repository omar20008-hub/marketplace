import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { prisma } from "@/lib/db";
import { n8n } from "@/lib/n8n";
import { answerMessage, answerOnPlatform } from "@/server/orchestrator/assistant";
import { ModelUnavailableError, type ChatModel, type ModelRequest } from "@/server/orchestrator/model";

/**
 * The platform Orchestrator as the chat sees it: the same inputs and outputs as
 * before, with the model scripted. Product runs go through the real run path and
 * the mock dispatcher, so these cases check what the person's own data does.
 */

const PLAN_ID = "test-plan";
const BASE = Date.UTC(2026, 9, 20, 9, 0, 0);

async function wipe() {
  await prisma.artifact.deleteMany({});
  await prisma.runStep.deleteMany({});
  await prisma.run.deleteMany({});
  await prisma.message.deleteMany({});
  await prisma.thread.deleteMany({});
  await prisma.installation.deleteMany({});
  await prisma.product.deleteMany({});
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
    include: { plan: true },
  });
}

async function makeInstalledProduct(userId: string) {
  const product = await prisma.product.create({
    data: {
      slug: `p-${Math.random().toString(36).slice(2, 10)}`,
      creatorId: userId,
      title: "Weekly Digest",
      summary: "s",
      description: "Summarises the week",
      needsFromYou: "n",
      kind: "WORKFLOW",
      category: "Reporting",
      actionType: "READ",
      status: "PUBLISHED",
    },
  });
  return prisma.installation.create({
    data: { userId, productId: product.id, pinnedVersion: "1.0", status: "ACTIVE" },
  });
}

/** Replies in order and records every request it was given. */
function scripted(replies: Array<{ text: string; toolCalls?: { id: string; name: string; args: Record<string, unknown> }[] } | Error>) {
  const requests: ModelRequest[] = [];
  const queue = [...replies];
  const model: ChatModel & { requests: ModelRequest[] } = {
    name: "scripted",
    requests,
    async generate(request) {
      requests.push(structuredClone(request));
      const next = queue.shift();
      if (!next) throw new Error("scripted model ran out of replies");
      if (next instanceof Error) throw next;
      return { text: next.text, toolCalls: next.toolCalls ?? [] };
    },
  };
  return model;
}

beforeEach(wipe);
afterEach(() => {
  vi.restoreAllMocks();
});
afterAll(async () => {
  await wipe();
  await prisma.$disconnect();
});

describe("answerOnPlatform", () => {
  it("runs the product the model asks for and returns the answer after it", async () => {
    const user = await makeUser("assistant-run@example.test");
    const installation = await makeInstalledProduct(user.id);
    const dispatch = vi.spyOn(n8n, "dispatch");
    const model = scripted([
      {
        text: "",
        toolCalls: [
          {
            id: "c1",
            name: "run_marketplace_tool",
            args: { installationId: installation.id, args: '{"chatInput":"هذا الأسبوع"}' },
          },
        ],
      },
      { text: "إليك الملخص." },
    ]);

    const answer = await answerOnPlatform({
      userId: user.id,
      chatInput: "لخص لي الأسبوع",
      models: [model],
    });

    expect(answer).toBe("إليك الملخص.");
    expect(dispatch).toHaveBeenCalledWith(
      expect.objectContaining({ userId: user.id, installationId: installation.id }),
    );
    expect(model.requests[0].system).toContain(installation.id);
  });

  it("gives the model the earlier messages of the thread, but not the one being answered", async () => {
    const user = await makeUser("assistant-history@example.test");
    const thread = await prisma.thread.create({ data: { userId: user.id, title: "محادثة" } });
    await prisma.message.create({
      data: { threadId: thread.id, role: "USER", body: "سؤال سابق", createdAt: new Date(BASE) },
    });
    await prisma.message.create({
      data: { threadId: thread.id, role: "ASSISTANT", body: "جواب سابق", createdAt: new Date(BASE + 1000) },
    });
    const current = await prisma.message.create({
      data: { threadId: thread.id, role: "USER", body: "السؤال الحالي", createdAt: new Date(BASE + 2000) },
    });
    const model = scripted([{ text: "ok" }]);

    await answerOnPlatform({
      userId: user.id,
      chatInput: "السؤال الحالي",
      threadId: thread.id,
      currentMessageId: current.id,
      models: [model],
    });

    expect(model.requests[0].messages.map((m) => m.role)).toEqual(["user", "assistant", "user"]);
    expect(model.requests[0].messages[0]).toEqual({ role: "user", content: "سؤال سابق" });
  });

  it("refuses another user's installation and runs nothing", async () => {
    const owner = await makeUser("assistant-owner@example.test");
    const intruder = await makeUser("assistant-intruder@example.test");
    const theirs = await makeInstalledProduct(owner.id);
    const dispatch = vi.spyOn(n8n, "dispatch");
    const model = scripted([
      {
        text: "",
        toolCalls: [
          { id: "c1", name: "run_marketplace_tool", args: { installationId: theirs.id, args: "{}" } },
        ],
      },
      { text: "لا أستطيع." },
    ]);

    await answerOnPlatform({ userId: intruder.id, chatInput: "شغّل", models: [model] });

    expect(dispatch).not.toHaveBeenCalled();
    expect(model.requests[0].system).toContain("لا توجد أدوات مفعّلة");
  });

  it("gives a guest no tools at all", async () => {
    const model = scripted([{ text: "مرحباً" }]);

    const answer = await answerOnPlatform({
      userId: "guest:abc123",
      chatInput: "مرحباً",
      models: [model],
    });

    expect(answer).toBe("مرحباً");
    expect(model.requests[0].system).toContain("لا توجد أدوات مفعّلة");
  });

  it("answers with the fixed line, not an exception, when no model is available", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const user = await makeUser("assistant-down@example.test");
    const model = scripted([new ModelUnavailableError("503")]);

    const answer = await answerOnPlatform({ userId: user.id, chatInput: "hi", models: [model] });

    expect(answer).toBe("Something went wrong reaching the assistant. Please try again in a moment.");
  });
});

describe("answerMessage", () => {
  it("uses the n8n Orchestrator while the platform one is not selected", async () => {
    const chat = vi.spyOn(n8n, "chat").mockResolvedValue({ output: "من n8n" });

    const answer = await answerMessage({ userId: "guest:xyz", chatInput: "hi" });

    expect(answer).toBe("من n8n");
    expect(chat).toHaveBeenCalledWith({ sessionId: "guest:xyz", chatInput: "hi" });
  });
});
