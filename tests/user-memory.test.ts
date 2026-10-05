import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * A person's memory as a few text files: how facts are added to them, how they leave,
 * what the Orchestrator is shown, and that one person's files never reach another's.
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

const lines = async (userId: string, name: string) => {
  const file = await prisma.memoryFile.findFirst({ where: { userId, name } });
  return file ? file.content.split("\n").filter(Boolean) : null;
};

describe("addFact", () => {
  it("adds a line to the file the fact belongs in, making the file the first time", async () => {
    const user = await seedUser();
    expect(await memory.addFact(user.id, "I run a coffee shop")).toEqual({
      ok: true,
      file: "Work",
      line: "I run a coffee shop",
      duplicate: false,
    });
    await memory.addFact(user.id, "I have five staff", { file: "Work" });
    await memory.addFact(user.id, "اسمي سعد");
    expect(await lines(user.id, "Work")).toEqual(["- I run a coffee shop", "- I have five staff"]);
    expect(await lines(user.id, "Profile")).toEqual(["- اسمي سعد"]);
  });

  it("does not add what a file already says, however it is written", async () => {
    const user = await seedUser();
    await memory.addFact(user.id, "I run a coffee shop");
    expect(await memory.addFact(user.id, "i run a Coffee shop.")).toMatchObject({ ok: true, duplicate: true });
    expect(await lines(user.id, "Work")).toHaveLength(1);
  });

  it("adds to a file the person made, and to one they edited by hand", async () => {
    const user = await seedUser();
    const made = await memory.createFile(user.id, "Clients");
    expect(made.ok).toBe(true);
    await memory.addFact(user.id, "Acme pays late", { file: "clients" });
    expect(await lines(user.id, "Clients")).toEqual(["- Acme pays late"]);

    const file = await prisma.memoryFile.findFirstOrThrow({ where: { userId: user.id, name: "Clients" } });
    await memory.saveFile(user.id, file.id, "Heading the person wrote\n- Acme pays late");
    await memory.addFact(user.id, "Beta pays early", { file: "Clients" });
    expect(await lines(user.id, "Clients")).toEqual(["Heading the person wrote", "- Acme pays late", "- Beta pays early"]);
  });

  it("refuses anything that looks like a secret or a way to reach someone", async () => {
    const user = await seedUser();
    for (const text of ["my email is a@b.co", "كلمة السر برتقال", "call +966 55 578 4625"]) {
      expect(await memory.addFact(user.id, text)).toEqual({ ok: false, reason: "rejected" });
    }
    expect(await prisma.memoryFile.count()).toBe(0);
  });

  it("refuses a line that would overfill a file, and keeps the file as it was", async () => {
    const user = await seedUser();
    const made = await memory.createFile(user.id, "Notes");
    if (!made.ok) throw new Error("setup");
    const filler = Array.from({ length: 28 }, (_, i) => `- line ${i} ${"y".repeat(90)}`).join("\n");
    await memory.saveFile(user.id, made.id, filler);
    const before = (await prisma.memoryFile.findFirstOrThrow({ where: { id: made.id } })).content;
    expect(await memory.addFact(user.id, "z".repeat(200), { file: "Notes" })).toEqual({ ok: false, reason: "full" });
    expect((await prisma.memoryFile.findFirstOrThrow({ where: { id: made.id } })).content).toBe(before);
  });

  it("puts a fact in Notes once the person has as many files as allowed", async () => {
    const user = await seedUser();
    await prisma.memoryFile.createMany({
      data: [...Array.from({ length: 11 }, (_, i) => `File ${i}`), "Notes"].map((name) => ({ userId: user.id, name })),
    });
    expect(await memory.addFact(user.id, "I like tea", { file: "A brand new file" })).toMatchObject({ ok: true, file: "Notes" });
    expect(await prisma.memoryFile.count()).toBe(12);
  });
});

describe("files", () => {
  it("creates, renames and deletes, without clashing or exceeding the limit", async () => {
    const user = await seedUser();
    const a = await memory.createFile(user.id, "Clients");
    expect(await memory.createFile(user.id, "clients")).toEqual({ ok: false, reason: "exists" });
    expect(await memory.createFile(user.id, "   ")).toEqual({ ok: false, reason: "name" });
    if (!a.ok) throw new Error("setup");

    const b = await memory.createFile(user.id, "Ideas");
    if (!b.ok) throw new Error("setup");
    expect(await memory.renameFile(user.id, b.id, "CLIENTS")).toEqual({ ok: false, reason: "exists" });
    expect(await memory.renameFile(user.id, b.id, "Plans")).toMatchObject({ ok: true, name: "Plans" });

    await memory.deleteFile(user.id, a.id);
    expect((await memory.listFiles(user.id)).map((f) => f.name)).toEqual(["Plans"]);

    await prisma.memoryFile.createMany({
      data: Array.from({ length: 11 }, (_, i) => ({ userId: user.id, name: `F${i}` })),
    });
    expect(await memory.createFile(user.id, "One too many")).toEqual({ ok: false, reason: "limit" });
  });

  it("saves what the person types, but not a secret, and not too much", async () => {
    const user = await seedUser();
    const made = await memory.createFile(user.id, "Notes");
    if (!made.ok) throw new Error("setup");
    expect(await memory.saveFile(user.id, made.id, "- fine\r\n- also fine   \n\n")).toEqual({ ok: true });
    expect(await lines(user.id, "Notes")).toEqual(["- fine", "- also fine"]);
    expect(await memory.saveFile(user.id, made.id, "- fine\n- my password is hunter2")).toEqual({
      ok: false,
      reason: "sensitive",
      line: 2,
    });
    expect(await memory.saveFile(user.id, made.id, "x".repeat(3001))).toEqual({ ok: false, reason: "too_long" });
    expect(await lines(user.id, "Notes")).toEqual(["- fine", "- also fine"]);
  });

  it("never lets one person read, change or delete another's file", async () => {
    const owner = await seedUser("owner@example.test");
    const made = await memory.createFile(owner.id, "Private");
    if (!made.ok) throw new Error("setup");
    await memory.addFact(owner.id, "I run a coffee shop", { file: "Private" });
    const other = await seedUser("other@example.test");

    expect(await memory.getFile(other.id, made.id)).toBeNull();
    expect(await memory.saveFile(other.id, made.id, "- overwritten")).toMatchObject({ ok: false, reason: "not_found" });
    await memory.deleteFile(other.id, made.id);
    expect((await memory.renameFile(other.id, made.id, "Mine")).ok).toBe(false);
    expect(await lines(owner.id, "Private")).toEqual(["- I run a coffee shop"]);
  });
});

describe("handleMemoryCommand", () => {
  it("adds to a file on request and answers in the language it was asked in", async () => {
    const user = await seedUser();
    const reply = await memory.handleMemoryCommand(user.id, "تذكر أن اسمي سعد");
    expect(reply).toMatch(/تم، أضفت «اسمي سعد» إلى ملف «Profile»/);
    const english = await memory.handleMemoryCommand(user.id, "Remember that I run a coffee shop");
    expect(english).toMatch(/^Done, I added "I run a coffee shop" to "Work"/);
    expect(await lines(user.id, "Profile")).toEqual(["- اسمي سعد"]);
  });

  it("adds to the file it is told, making it if needed", async () => {
    const user = await seedUser();
    const reply = await memory.handleMemoryCommand(user.id, "remember in my Clients file that Acme pays late");
    expect(reply).toMatch(/added "Acme pays late" to "Clients"/);
    expect(await lines(user.id, "Clients")).toEqual(["- Acme pays late"]);
  });

  it("keeps each fact in a request as its own line, so forgetting one leaves the others", async () => {
    const user = await seedUser();
    await memory.handleMemoryCommand(user.id, "تذكر أن اسمي سعد وأعمل في مقهى");
    expect(await lines(user.id, "Profile")).toEqual(["- اسمي سعد"]);
    expect(await lines(user.id, "Work")).toEqual(["- أعمل في مقهى"]);

    expect(await memory.handleMemoryCommand(user.id, "انس أن اسمي سعد")).toMatch(/حذفت 1 سطراً/);
    expect(await lines(user.id, "Profile")).toEqual([]);
    expect(await lines(user.id, "Work")).toEqual(["- أعمل في مقهى"]);
  });

  it("saves the part that is fine and says it skipped the rest", async () => {
    const user = await seedUser();
    const reply = await memory.handleMemoryCommand(user.id, "Remember that I run a coffee shop and my email is a@b.co");
    expect(reply).toMatch(/added "I run a coffee shop" to "Work"\./);
    expect(reply).toMatch(/did not save part of it/);
  });

  it("says why it will not keep something sensitive", async () => {
    const user = await seedUser();
    expect(await memory.handleMemoryCommand(user.id, "Remember that my password is hunter2")).toMatch(/cannot save that/i);
    expect(await prisma.memoryFile.count()).toBe(0);
  });

  it("forgets what is named, across files, and says when there was nothing", async () => {
    const user = await seedUser();
    await memory.addFact(user.id, "I run a coffee shop");
    await memory.addFact(user.id, "I prefer short answers");
    expect(await memory.handleMemoryCommand(user.id, "forget about the coffee shop")).toMatch(/removed 1 line/);
    expect(await lines(user.id, "Preferences")).toEqual(["- I prefer short answers"]);
    expect(await memory.handleMemoryCommand(user.id, "forget the bakery")).toMatch(/did not find/);
  });

  it("leaves an ordinary message alone", async () => {
    const user = await seedUser();
    expect(await memory.handleMemoryCommand(user.id, "ما ملخص الملف؟")).toBeNull();
  });
});

describe("what the Orchestrator is shown", () => {
  it("puts the person's files in front of the message, and nothing else when there are none", async () => {
    const user = await seedUser();
    expect(await memory.withMemories(user.id, "hello")).toBe("hello");
    await memory.addFact(user.id, "I run a coffee shop");
    await memory.addFact(user.id, "I prefer short answers");
    const shown = await memory.withMemories(user.id, "hello");
    expect(shown).toContain("## Work\n- I run a coffee shop");
    expect(shown).toContain("## Preferences\n- I prefer short answers");
    expect(shown.endsWith("\n\nhello")).toBe(true);
  });

  it("never shows one person's files to another", async () => {
    const a = await seedUser("a@example.test");
    await memory.addFact(a.id, "A runs a coffee shop");
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
    expect(await lines(user.id, "Profile")).toEqual(["- اسمي سعد"]);
    const messages = await prisma.message.findMany({ orderBy: { createdAt: "asc" } });
    expect(messages[1].body).toMatch(/أضفت/);
  });

  it("sends the Orchestrator the files, while the thread keeps exactly what was written", async () => {
    const user = await seedUser();
    await memory.addFact(user.id, "I run a coffee shop");
    const thread = await prisma.thread.create({ data: { userId: user.id, title: "T" } });

    await followUp(form({ threadId: thread.id, message: "what should I sell?" }));

    expect(chatCalls).toHaveLength(1);
    expect(chatCalls[0].chatInput).toContain("## Work\n- I run a coffee shop");
    expect(chatCalls[0].chatInput.endsWith("what should I sell?")).toBe(true);
    const stored = await prisma.message.findMany({ where: { threadId: thread.id }, orderBy: { createdAt: "asc" } });
    expect(stored[0].body).toBe("what should I sell?");
  });
});

describe("learning from what the person wrote", () => {
  it("adds what the model picks out to the file it names, and refuses what is sensitive", async () => {
    const user = await seedUser();
    memory.memoryRuntime.extract = async () => [
      { file: "Work", text: "User runs a logistics company" },
      { text: "I prefer short answers" },
      { file: "Profile", text: "my email is a@b.co" },
    ];
    const added = await memory.learnFromMessage(user.id, "I run a logistics company and I prefer short answers");
    expect(added).toBe(2);
    expect(await lines(user.id, "Work")).toEqual(["- User runs a logistics company"]);
    expect(await lines(user.id, "Preferences")).toEqual(["- I prefer short answers"]);
    expect(await lines(user.id, "Profile")).toBeNull();
  });

  it("shows the model the files as they are, so it does not repeat itself", async () => {
    const user = await seedUser();
    await memory.addFact(user.id, "I run a logistics company");
    let seen: Record<string, string> = {};
    memory.memoryRuntime.extract = async (_message, files) => {
      seen = files;
      return [];
    };
    await memory.learnFromMessage(user.id, "I run a logistics company");
    expect(seen).toEqual({ Work: "- I run a logistics company" });
  });

  it("does not ask the model about an ordinary request", async () => {
    const user = await seedUser();
    const extract = vi.fn(async () => [{ text: "something" }]);
    memory.memoryRuntime.extract = extract;
    expect(await memory.learnFromMessage(user.id, "ما ملخص ملف alslam.pdf في ملفاتي؟")).toBe(0);
    expect(extract).not.toHaveBeenCalled();
  });

  it("does nothing once the person has switched learning off", async () => {
    const user = await seedUser();
    await prisma.user.update({ where: { id: user.id }, data: { memoryAuto: false } });
    const extract = vi.fn(async () => [{ text: "User runs a logistics company" }]);
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
  it("creates a file, adds a line and saves edits, each ending on the page with a note", async () => {
    const owner = await seedUser();
    const created = await destination(() => actions.createMemoryFileAction(form({ name: "Clients" })));
    const file = await prisma.memoryFile.findFirstOrThrow({ where: { userId: owner.id } });
    expect(created).toBe(`/memory?file=${file.id}&note=created`);

    expect(await destination(() => actions.addMemoryLineAction(form({ id: file.id, content: "Acme pays late" })))).toBe(
      `/memory?file=${file.id}&note=saved`,
    );
    expect(await destination(() => actions.saveMemoryFileAction(form({ id: file.id, content: "- Acme pays late\n- Beta" })))).toBe(
      `/memory?file=${file.id}&note=saved`,
    );
    expect(await lines(owner.id, "Clients")).toEqual(["- Acme pays late", "- Beta"]);
  });

  it("explains a refusal instead of failing silently", async () => {
    const owner = await seedUser();
    await destination(() => actions.createMemoryFileAction(form({ name: "Notes" })));
    const file = await prisma.memoryFile.findFirstOrThrow({ where: { userId: owner.id } });
    expect(await destination(() => actions.saveMemoryFileAction(form({ id: file.id, content: "ok\nmy password is x" })))).toBe(
      `/memory?file=${file.id}&note=sensitive-2`,
    );
    expect(await destination(() => actions.addMemoryLineAction(form({ id: file.id, content: "my password is x" })))).toBe(
      `/memory?file=${file.id}&note=rejected`,
    );
    expect(await destination(() => actions.createMemoryFileAction(form({ name: "notes" })))).toBe("/memory?note=exists");
  });

  it("touches only the signed-in person's files", async () => {
    const owner = await seedUser("owner@example.test");
    await destination(() => actions.createMemoryFileAction(form({ name: "Mine" })));
    const mine = await prisma.memoryFile.findFirstOrThrow({ where: { userId: owner.id } });

    await seedUser("intruder@example.test");
    await destination(() => actions.deleteMemoryFileAction(form({ id: mine.id, confirm: "yes" })));
    await destination(() => actions.saveMemoryFileAction(form({ id: mine.id, content: "- overwritten" })));
    await destination(() => actions.addMemoryLineAction(form({ id: mine.id, content: "an intruder line" })));
    expect(await prisma.memoryFile.count()).toBe(1);
    expect((await prisma.memoryFile.findFirstOrThrow()).content).toBe("");
  });

  it("asks to confirm before deleting a file or everything", async () => {
    const owner = await seedUser();
    await memory.addFact(owner.id, "I run a coffee shop");
    const file = await prisma.memoryFile.findFirstOrThrow({ where: { userId: owner.id } });

    expect(await destination(() => actions.deleteMemoryFileAction(form({ id: file.id })))).toBe(`/memory?file=${file.id}&note=confirm`);
    expect(await destination(() => actions.clearMemoriesAction(form({})))).toBe("/memory?note=confirm");
    expect(await prisma.memoryFile.count()).toBe(1);

    expect(await destination(() => actions.deleteMemoryFileAction(form({ id: file.id, confirm: "yes" })))).toBe("/memory?note=deleted");
    await memory.addFact(owner.id, "I run a coffee shop");
    expect(await destination(() => actions.clearMemoriesAction(form({ confirm: "yes" })))).toBe("/memory?note=cleared");
    expect(await prisma.memoryFile.count()).toBe(0);
  });

  it("switches learning on and off", async () => {
    const owner = await seedUser();
    expect(await destination(() => actions.setAutoMemoryAction(form({})))).toBe("/memory");
    expect((await prisma.user.findUniqueOrThrow({ where: { id: owner.id } })).memoryAuto).toBe(false);
    await destination(() => actions.setAutoMemoryAction(form({ auto: "on" })));
    expect((await prisma.user.findUniqueOrThrow({ where: { id: owner.id } })).memoryAuto).toBe(true);
  });
});
