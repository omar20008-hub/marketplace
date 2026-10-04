import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Lasting facts about a person: how they get in, how they get out, what the
 * Orchestrator is shown, and that one person's memory never reaches another's.
 */

const viewer = vi.hoisted(() => ({ current: null as { id: string } | null }));

class Redirected extends Error {
  constructor(readonly to: string) {
    super(`redirect:${to}`);
  }
}

vi.mock("@/lib/auth", () => ({
  requireUser: async () => {
    if (!viewer.current) throw new Redirected("/login");
    return viewer.current;
  },
}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("next/navigation", () => ({
  redirect: (to: string) => {
    throw new Redirected(to);
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
const memory = await import("@/server/memory");
const actions = await import("@/server/memory-actions");
const { startTask } = await import("@/server/run-actions");
const { followUp } = await import("@/server/thread-actions");

const PLAN_ID = "test-plan-user-memory";

async function wipe() {
  await prisma.message.deleteMany({});
  await prisma.thread.deleteMany({});
  await prisma.user.deleteMany({});
  await prisma.plan.deleteMany({});
}

async function seedUser(email = "owner@example.test") {
  await prisma.plan.upsert({
    where: { id: PLAN_ID },
    create: { id: PLAN_ID, name: "T", monthlyRuns: 1, storageBytes: BigInt(1), monthlyCredits: 0 },
    update: {},
  });
  const user = await prisma.user.create({
    data: { email, name: email, passwordHash: "x", initials: "U", planId: PLAN_ID },
  });
  viewer.current = user;
  return user;
}

const form = (fields: Record<string, string>) => {
  const data = new FormData();
  for (const [key, value] of Object.entries(fields)) data.set(key, value);
  return data;
};

const destination = async (run: () => Promise<unknown>) => {
  try {
    await run();
  } catch (error) {
    if (error instanceof Redirected) return error.to;
    throw error;
  }
  return null;
};

beforeEach(async () => {
  await wipe();
  chatCalls.length = 0;
  memory.memoryRuntime.extract = async () => [];
});
afterAll(async () => {
  await wipe();
  await prisma.$disconnect();
});

describe("addMemory", () => {
  it("stores a fact, and a repeat of it only freshens it", async () => {
    const user = await seedUser();
    expect(await memory.addMemory(user.id, "I run a coffee shop", "EXPLICIT")).toMatchObject({
      ok: true,
      duplicate: false,
    });
    expect(await memory.addMemory(user.id, "i run a Coffee shop.", "AUTO")).toMatchObject({
      ok: true,
      duplicate: true,
    });
    expect(await prisma.userMemory.count()).toBe(1);
  });

  it("refuses anything that looks like a secret or a way to reach someone", async () => {
    const user = await seedUser();
    for (const text of ["my email is a@b.co", "كلمة السر برتقال", "call +966 55 578 4625"]) {
      expect(await memory.addMemory(user.id, text, "EXPLICIT")).toEqual({ ok: false, reason: "rejected" });
    }
    expect(await prisma.userMemory.count()).toBe(0);
  });

  it("makes room by dropping what was learned, never what the person wrote", async () => {
    const user = await seedUser();
    await prisma.userMemory.createMany({
      data: Array.from({ length: 50 }, (_, i) => ({
        userId: user.id,
        content: `learned fact ${i}`,
        source: "AUTO" as const,
        updatedAt: new Date(2026, 0, 1 + i),
      })),
    });
    expect((await memory.addMemory(user.id, "I prefer short answers", "EXPLICIT")).ok).toBe(true);
    expect(await prisma.userMemory.count()).toBe(50);
    expect(await prisma.userMemory.findFirst({ where: { content: "learned fact 0" } })).toBeNull();
    expect(await prisma.userMemory.findFirst({ where: { content: "I prefer short answers" } })).not.toBeNull();

    await prisma.userMemory.deleteMany({ where: { source: "AUTO" } });
    await prisma.userMemory.createMany({
      data: Array.from({ length: 50 }, (_, i) => ({ userId: user.id, content: `mine ${i}`, source: "EXPLICIT" as const })),
    });
    expect(await memory.addMemory(user.id, "one more thing", "EXPLICIT")).toEqual({ ok: false, reason: "full" });
  });
});

describe("handleMemoryCommand", () => {
  it("remembers on request and answers in the language it was asked in", async () => {
    const user = await seedUser();
    const reply = await memory.handleMemoryCommand(user.id, "تذكر أن اسمي سعد");
    expect(reply).toMatch(/تم، سأتذكر: «اسمي سعد»/);
    const english = await memory.handleMemoryCommand(user.id, "Remember that I run a coffee shop");
    expect(english).toMatch(/^Done, I will remember: "I run a coffee shop"/);
    expect((await prisma.userMemory.findMany()).map((m) => m.source)).toEqual(["EXPLICIT", "EXPLICIT"]);
  });

  it("says why it will not keep something sensitive", async () => {
    const user = await seedUser();
    const reply = await memory.handleMemoryCommand(user.id, "Remember that my password is hunter2");
    expect(reply).toMatch(/cannot save that/i);
    expect(await prisma.userMemory.count()).toBe(0);
  });

  it("forgets what is named, and says when there was nothing", async () => {
    const user = await seedUser();
    await memory.addMemory(user.id, "I run a coffee shop", "EXPLICIT");
    await memory.addMemory(user.id, "I prefer short answers", "EXPLICIT");
    expect(await memory.handleMemoryCommand(user.id, "forget about the coffee shop")).toMatch(/forgot 1 thing/);
    expect((await prisma.userMemory.findMany()).map((m) => m.content)).toEqual(["I prefer short answers"]);
    expect(await memory.handleMemoryCommand(user.id, "forget the bakery")).toMatch(/did not find/);
  });

  it("leaves an ordinary message alone", async () => {
    const user = await seedUser();
    expect(await memory.handleMemoryCommand(user.id, "ما ملخص الملف؟")).toBeNull();
  });
});

describe("what the Orchestrator is shown", () => {
  it("puts the person's facts in front of the message, and nothing else when there are none", async () => {
    const user = await seedUser();
    expect(await memory.withMemories(user.id, "hello")).toBe("hello");
    await memory.addMemory(user.id, "I run a coffee shop", "EXPLICIT");
    const shown = await memory.withMemories(user.id, "hello");
    expect(shown).toContain("- I run a coffee shop");
    expect(shown.endsWith("\n\nhello")).toBe(true);
  });

  it("never shows one person's facts to another", async () => {
    const a = await seedUser("a@example.test");
    await memory.addMemory(a.id, "A runs a coffee shop", "EXPLICIT");
    const b = await seedUser("b@example.test");
    expect(await memory.withMemories(b.id, "hello")).toBe("hello");
  });
});

describe("in a conversation", () => {
  it("answers a remember request itself, without calling the Orchestrator", async () => {
    const user = await seedUser();
    const to = await destination(() => startTask(form({ task: "تذكر أن اسمي سعد" })));
    expect(to).toMatch(/^\/tasks\//);
    expect(chatCalls).toEqual([]);
    expect(await prisma.userMemory.count({ where: { userId: user.id } })).toBe(1);
    const messages = await prisma.message.findMany({ orderBy: { createdAt: "asc" } });
    expect(messages[1].body).toMatch(/سأتذكر/);
  });

  it("sends the Orchestrator the facts, while the thread keeps exactly what was written", async () => {
    const user = await seedUser();
    await memory.addMemory(user.id, "I run a coffee shop", "EXPLICIT");
    const thread = await prisma.thread.create({ data: { userId: user.id, title: "T" } });

    await followUp(form({ threadId: thread.id, message: "what should I sell?" }));

    expect(chatCalls).toHaveLength(1);
    expect(chatCalls[0].chatInput).toContain("- I run a coffee shop");
    expect(chatCalls[0].chatInput.endsWith("what should I sell?")).toBe(true);
    const stored = await prisma.message.findMany({ where: { threadId: thread.id }, orderBy: { createdAt: "asc" } });
    expect(stored[0].body).toBe("what should I sell?");
  });
});

describe("learning from what the person wrote", () => {
  it("keeps what the model picks out, marked as learned", async () => {
    const user = await seedUser();
    memory.memoryRuntime.extract = async () => ["User runs a logistics company", "my email is a@b.co"];
    const added = await memory.learnFromMessage(user.id, "I run a logistics company and I prefer short answers");
    expect(added).toBe(1); // the second one is refused as sensitive
    expect(await prisma.userMemory.findMany()).toMatchObject([
      { content: "User runs a logistics company", source: "AUTO" },
    ]);
  });

  it("does not ask the model about an ordinary request", async () => {
    const user = await seedUser();
    const extract = vi.fn(async () => ["something"]);
    memory.memoryRuntime.extract = extract;
    expect(await memory.learnFromMessage(user.id, "ما ملخص ملف alslam.pdf في ملفاتي؟")).toBe(0);
    expect(extract).not.toHaveBeenCalled();
  });

  it("does nothing once the person has switched learning off", async () => {
    const user = await seedUser();
    await prisma.user.update({ where: { id: user.id }, data: { memoryAuto: false } });
    const extract = vi.fn(async () => ["User runs a logistics company"]);
    memory.memoryRuntime.extract = extract;
    expect(await memory.learnFromMessage(user.id, "I run a logistics company")).toBe(0);
    expect(extract).not.toHaveBeenCalled();
  });

  it("never lets a model failure reach the conversation", async () => {
    const user = await seedUser();
    memory.memoryRuntime.extract = async () => {
      throw new Error("memory model answered 503");
    };
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(await memory.learnFromMessage(user.id, "I run a logistics company")).toBe(0);
    warn.mockRestore();
  });
});

describe("the Memory page actions", () => {
  it("adds, then deletes, only the signed-in person's own rows", async () => {
    const owner = await seedUser("owner@example.test");
    expect(await destination(() => actions.addMemoryAction(form({ content: "I run a coffee shop" })))).toBe("/memory?note=saved");
    const mine = await prisma.userMemory.findFirstOrThrow({ where: { userId: owner.id } });

    await seedUser("intruder@example.test");
    await actions.deleteMemoryAction(form({ id: mine.id }));
    expect(await prisma.userMemory.count()).toBe(1);

    viewer.current = owner;
    await actions.deleteMemoryAction(form({ id: mine.id }));
    expect(await prisma.userMemory.count()).toBe(0);
  });

  it("refuses a secret with a reason, and asks to confirm before deleting everything", async () => {
    const owner = await seedUser();
    expect(await destination(() => actions.addMemoryAction(form({ content: "my password is hunter2" })))).toBe("/memory?note=rejected");
    await memory.addMemory(owner.id, "I run a coffee shop", "EXPLICIT");

    expect(await destination(() => actions.clearMemoriesAction(form({})))).toBe("/memory?note=confirm");
    expect(await prisma.userMemory.count()).toBe(1);
    expect(await destination(() => actions.clearMemoriesAction(form({ confirm: "yes" })))).toBe("/memory?note=cleared");
    expect(await prisma.userMemory.count()).toBe(0);
  });

  it("switches learning on and off", async () => {
    const owner = await seedUser();
    await actions.setAutoMemoryAction(form({}));
    expect((await prisma.user.findUniqueOrThrow({ where: { id: owner.id } })).memoryAuto).toBe(false);
    await actions.setAutoMemoryAction(form({ auto: "on" }));
    expect((await prisma.user.findUniqueOrThrow({ where: { id: owner.id } })).memoryAuto).toBe(true);
  });
});
