import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Inside a request the reply is made after the response: the person's message is
 * stored and the page is shown at once, and the answer lands later. (Outside a
 * request the other suites see it inline.)
 */

const viewer = vi.hoisted(() => ({ current: null as { id: string } | null }));
const deferred = vi.hoisted(() => [] as (() => unknown)[]);

class Redirected extends Error {
  constructor(readonly to: string) {
    super(`redirect:${to}`);
  }
}

vi.mock("@/lib/auth", () => ({ requireUser: async () => viewer.current }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("next/navigation", () => ({
  redirect: (to: string) => {
    throw new Redirected(to);
  },
}));
vi.mock("next/server", async (importOriginal) => ({
  ...(await importOriginal<typeof import("next/server")>()),
  after: (work: () => unknown) => {
    deferred.push(work);
  },
}));
const chat = vi.hoisted(() => ({ inputs: [] as string[], fail: false }));
vi.mock("@/lib/n8n", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/n8n")>();
  return {
    ...actual,
    n8n: {
      ...actual.n8n,
      chat: async (i: { chatInput: string }) => {
        chat.inputs.push(i.chatInput);
        if (chat.fail) throw new Error("down");
        return { output: `answered ${i.chatInput}` };
      },
    },
  };
});

const { prisma } = await import("@/lib/db");
const { startTask } = await import("@/server/run-actions");
const { followUp } = await import("@/server/thread-actions");
const { answerThread } = await import("@/server/thread-reply");
const { orchestratorRuntime } = await import("@/server/run-engine");
const { memoryRuntime } = await import("@/server/memory");

async function wipe() {
  await prisma.message.deleteMany({});
  await prisma.thread.deleteMany({});
  await prisma.memoryFile.deleteMany({});
  await prisma.user.deleteMany({});
  await prisma.plan.deleteMany({});
}

const profile = async () =>
  (await prisma.memoryFile.findFirst({ where: { userId: viewer.current!.id, name: "Profile" } }))?.content ?? "";

beforeEach(async () => {
  await wipe();
  deferred.length = 0;
  chat.inputs.length = 0;
  chat.fail = false;
  orchestratorRuntime.sleep = async () => {};
  memoryRuntime.extract = async () => [];
  await prisma.plan.create({
    data: { id: "tr", name: "T", monthlyRuns: 1, storageBytes: BigInt(1), monthlyCredits: 0 },
  });
  viewer.current = await prisma.user.create({
    data: { email: "r@example.test", name: "R", passwordHash: "x", initials: "R", planId: "tr" },
  });
});
afterAll(async () => {
  await wipe();
  await prisma.$disconnect();
});

const form = (fields: Record<string, string>) => {
  const f = new FormData();
  for (const [k, v] of Object.entries(fields)) f.set(k, v);
  return f;
};

describe("replying after the response", () => {
  it("startTask stores the question and redirects before any answer exists", async () => {
    const to = await startTask(form({ task: "what is two plus two" })).catch((e) => (e as Redirected).to);
    expect(to).toMatch(/^\/tasks\//);

    let messages = await prisma.message.findMany();
    expect(messages.map((m) => [m.role, m.body])).toEqual([["USER", "what is two plus two"]]);

    await deferred[0]();
    messages = await prisma.message.findMany({ orderBy: { createdAt: "asc" } });
    expect(messages.map((m) => [m.role, m.body])).toEqual([
      ["USER", "what is two plus two"],
      ["ASSISTANT", "answered what is two plus two"],
    ]);
  });

  it("followUp stores the message and returns before the answer", async () => {
    const thread = await prisma.thread.create({ data: { userId: viewer.current!.id, title: "t" } });
    await followUp(form({ threadId: thread.id, message: "and then?" }));
    expect(await prisma.message.count({ where: { role: "ASSISTANT" } })).toBe(0);

    await deferred[0]();
    expect((await prisma.message.findFirstOrThrow({ where: { role: "ASSISTANT" } })).body).toBe("answered and then?");
  });

  it("stores exactly one assistant message with the orchestrator output", async () => {
    const thread = await prisma.thread.create({ data: { userId: viewer.current!.id, title: "t" } });
    await answerThread(viewer.current!.id, thread.id, "hello");
    const replies = await prisma.message.findMany({ where: { role: "ASSISTANT" } });
    expect(replies.map((m) => m.body)).toEqual(["answered hello"]);
  });

  it("stores the fallback text when the orchestrator keeps failing", async () => {
    chat.fail = true;
    const thread = await prisma.thread.create({ data: { userId: viewer.current!.id, title: "t" } });
    await answerThread(viewer.current!.id, thread.id, "hello");
    const replies = await prisma.message.findMany({ where: { role: "ASSISTANT" } });
    expect(replies).toHaveLength(1);
    expect(replies[0].body).toMatch(/^Something went wrong/);
  });

  it("adds little time of its own to the reply", async () => {
    const thread = await prisma.thread.create({ data: { userId: viewer.current!.id, title: "t" } });
    const started = Date.now();
    await answerThread(viewer.current!.id, thread.id, "اسمي سعد");
    expect(Date.now() - started).toBeLessThan(5000);
  });

  describe("a name the person states", () => {
    const ask = async (text: string) => {
      const thread = await prisma.thread.create({ data: { userId: viewer.current!.id, title: "t" } });
      await answerThread(viewer.current!.id, thread.id, text);
    };

    it("is saved before the orchestrator is asked, in Arabic", async () => {
      await ask("اسمي سعد");
      expect(await profile()).toContain("اسم المستخدم سعد");
      expect(chat.inputs[0]).toContain("اسم المستخدم سعد");
      expect(await prisma.message.count({ where: { role: "ASSISTANT" } })).toBe(1);
    });

    it("is saved in English", async () => {
      await ask("my name is Saad");
      expect(await profile()).toContain("User's name is Saad");
    });

    it("is not duplicated, and a different name is added beside it", async () => {
      await ask("اسمي سعد");
      await ask("اسمي سعد");
      await ask("اسمي خالد");
      expect((await profile()).split("\n")).toEqual(["- اسم المستخدم سعد", "- اسم المستخدم خالد"]);
    });

    it("is not saved when the person switched learning off", async () => {
      await prisma.user.update({ where: { id: viewer.current!.id }, data: { memoryAuto: false } });
      await ask("اسمي سعد");
      expect(await profile()).toBe("");
      expect(chat.inputs).toHaveLength(1);
      expect(await prisma.message.count({ where: { role: "ASSISTANT" } })).toBe(1);
    });

    it("is saved once when asked for with a command", async () => {
      await ask("تذكر أن اسمي سعد");
      expect((await profile()).match(/سعد/g)).toHaveLength(1);
      expect(chat.inputs).toHaveLength(0);
    });

    it("never stops the reply when saving fails", async () => {
      const spy = vi.spyOn(prisma.memoryFile, "update").mockRejectedValueOnce(new Error("db"));
      await ask("اسمي سعد");
      spy.mockRestore();
      expect(await prisma.message.count({ where: { role: "ASSISTANT" } })).toBe(1);
      expect(chat.inputs).toHaveLength(1);
    });
  });
});
