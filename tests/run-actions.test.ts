import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The three form actions, and the thread follow-up.
 *
 * executeRun() itself is covered in run-engine.test.ts; what these add is the
 * part around it — the thread a run gets written into, and the rule that the
 * conversation's session id is the authenticated user and never anything the
 * browser sent. Which product to run, if any, is the Orchestrator's call:
 * startTask and followUp both hand it the message as written and show back
 * whatever it answers, rather than matching locally.
 */

const viewer = vi.hoisted(() => ({
  current: null as { id: string; plan?: unknown } | null,
}));

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

/** Records what the orchestrator was asked, so the session id can be checked. */
const chatCalls: { sessionId: string; chatInput: string }[] = [];
/** Set per-test to make the next chat() call reject, the way a timeout or a 5xx would. */
const chatFailure = vi.hoisted(() => ({ next: null as Error | null }));
vi.mock("@/lib/n8n", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/n8n")>();
  return {
    ...actual,
    n8n: {
      ...actual.n8n,
      chat: async (input: { sessionId: string; chatInput: string }) => {
        chatCalls.push(input);
        if (chatFailure.next) {
          const error = chatFailure.next;
          chatFailure.next = null;
          throw error;
        }
        return { output: `answered ${input.chatInput}` };
      },
    },
  };
});

const { prisma } = await import("@/lib/db");
const { provideInputs, runFromWorkspace, startTask } = await import(
  "@/server/run-actions"
);
const { followUp } = await import("@/server/thread-actions");

const PLAN_ID = "test-plan-run-actions";

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

async function seedUser(email = "owner@example.test") {
  await prisma.plan.upsert({
    where: { id: PLAN_ID },
    create: {
      id: PLAN_ID,
      name: "Test",
      monthlyRuns: 100,
      storageBytes: BigInt(1_000_000),
      monthlyCredits: 0,
    },
    update: {},
  });
  const user = await prisma.user.create({
    data: {
      email,
      name: "Owner",
      passwordHash: "x",
      initials: "OW",
      planId: PLAN_ID,
    },
    include: { plan: true },
  });
  viewer.current = user;
  return user;
}

async function seedProduct(
  userId: string,
  {
    title = "Expense Report Builder",
    summary = "Turns a transactions sheet into an expense report.",
    category = "Finance",
    inputSchema = [] as unknown[],
  } = {},
) {
  const product = await prisma.product.create({
    data: {
      slug: `p-${Math.random().toString(36).slice(2, 8)}`,
      creatorId: userId,
      title,
      summary,
      description: "d",
      needsFromYou: "n",
      kind: "WORKFLOW",
      category,
      status: "PUBLISHED",
      inputSchema: inputSchema as never,
    },
  });
  const installation = await prisma.installation.create({
    data: {
      userId,
      productId: product.id,
      pinnedVersion: "1.0",
      status: "ACTIVE",
      installationId: `inst_${Math.random().toString(36).slice(2, 8)}`,
    },
  });
  return { product, installation };
}

function form(values: Record<string, string>) {
  const data = new FormData();
  for (const [key, value] of Object.entries(values)) data.append(key, value);
  return data;
}

/** Runs something that ends in a redirect, and reports where it went. */
async function destinationOf(run: () => Promise<unknown>) {
  try {
    await run();
    return null;
  } catch (error) {
    if (error instanceof Redirected) return error.to;
    throw error;
  }
}

beforeEach(async () => {
  chatCalls.length = 0;
  chatFailure.next = null;
  await wipe();
});

afterAll(async () => {
  await wipe();
  await prisma.$disconnect();
});

describe("startTask", () => {
  it("opens a thread and asks the orchestrator, never matching locally", async () => {
    const user = await seedUser();

    const to = await destinationOf(() =>
      startTask(form({ task: "Build my expense report for last month" })),
    );

    expect(to).toMatch(/^\/tasks\//);
    expect(chatCalls).toEqual([
      { sessionId: user.id, chatInput: "Build my expense report for last month" },
    ]);
    const thread = await prisma.thread.findFirst({
      include: { messages: { orderBy: { createdAt: "asc" } } },
    });
    expect(thread!.messages[0]).toMatchObject({ role: "USER" });
    expect(thread!.messages[1]).toMatchObject({
      role: "ASSISTANT",
      body: "answered Build my expense report for last month",
    });
    // Whether anything runs is the Orchestrator's decision, made on its own
    // side of the boundary — this platform never invents that call itself.
    expect(await prisma.run.count()).toBe(0);
  });

  it("titles the thread from the task, capitalised and cut short", async () => {
    await seedUser();

    await destinationOf(() =>
      startTask(form({ task: "build my expense report" })),
    );

    expect(await prisma.thread.findFirst()).toMatchObject({
      title: "Build my expense report",
    });
  });

  it("trims a long title rather than storing the whole message", async () => {
    await seedUser();

    await destinationOf(() => startTask(form({ task: "expense ".repeat(20) })));

    const thread = await prisma.thread.findFirst();
    expect(thread!.title.length).toBeLessThanOrEqual(48);
    expect(thread!.title.endsWith("…")).toBe(true);
  });

  it("does nothing at all for an empty task", async () => {
    await seedUser();

    await startTask(form({ task: "   " }));

    expect(await prisma.thread.count()).toBe(0);
    expect(chatCalls).toEqual([]);
  });

  it("shows whatever the orchestrator answers, verbatim", async () => {
    await seedUser();

    await destinationOf(() =>
      startTask(form({ task: "Something entirely unrelated aaaaa" })),
    );

    const thread = await prisma.thread.findFirst({ include: { messages: true } });
    expect(thread!.messages).toHaveLength(2);
    // No locally-programmed "Marketplace" copy — the reply is the
    // Orchestrator's, unmodified.
    expect(thread!.messages[1].body).toBe(
      "answered Something entirely unrelated aaaaa",
    );
  });

  it("carries the pinned product as context, rather than choosing for the orchestrator", async () => {
    const user = await seedUser();
    const { installation: pinned } = await seedProduct(user.id, {
      title: "Contract Reviewer",
      summary: "Flags unusual clauses.",
      category: "Legal",
    });

    await destinationOf(() =>
      startTask(
        form({ task: "expense report please", installationId: pinned.id }),
      ),
    );

    expect(chatCalls).toEqual([
      {
        sessionId: user.id,
        chatInput: "[Product: Contract Reviewer] expense report please",
      },
    ]);
  });

  it("sends a stranger to sign-in without writing anything", async () => {
    viewer.current = null;

    expect(await destinationOf(() => startTask(form({ task: "anything" })))).toBe(
      "/login",
    );
    expect(await prisma.thread.count()).toBe(0);
    expect(chatCalls).toEqual([]);
  });

  it("shows a generic message, not a crash or a made-up match, when the orchestrator is unreachable", async () => {
    await seedUser();
    chatFailure.next = new Error("n8n replied 503");

    await destinationOf(() => startTask(form({ task: "anything" })));

    const thread = await prisma.thread.findFirst({ include: { messages: true } });
    expect(thread!.messages[1].body).toBe(
      "Something went wrong reaching the assistant. Please try again in a moment.",
    );
  });
});

describe("runFromWorkspace", () => {
  it("opens a thread so the result has a home", async () => {
    const user = await seedUser();
    const { installation } = await seedProduct(user.id);

    const to = await destinationOf(() =>
      runFromWorkspace(form({ installationId: installation.id })),
    );

    expect(to).toMatch(/^\/tasks\//);
    expect(await prisma.thread.findFirst()).toMatchObject({
      title: "Expense Report Builder",
    });
    expect(await prisma.run.count()).toBe(1);
  });

  it("does nothing for an installation that is not the caller's", async () => {
    const first = await seedUser("first@example.test");
    const { installation } = await seedProduct(first.id);
    await seedUser("second@example.test");

    await runFromWorkspace(form({ installationId: installation.id }));

    expect(await prisma.thread.count()).toBe(0);
    expect(await prisma.run.count()).toBe(0);
  });
});

describe("provideInputs", () => {
  it("re-runs with what the person supplied, and types it as declared", async () => {
    const user = await seedUser();
    const { installation } = await seedProduct(user.id, {
      inputSchema: [
        { name: "olderThanDays", label: "Older than", type: "number", required: true },
      ],
    });

    // A run with a missing required field, the way the explicit Run button
    // from Workspace starts one — startTask no longer executes anything
    // itself, so it is not the path that creates the INCOMPLETE run here.
    await destinationOf(() =>
      runFromWorkspace(form({ installationId: installation.id })),
    );
    const incomplete = await prisma.run.findFirst();
    expect(incomplete).toMatchObject({ result: "INCOMPLETE" });

    await provideInputs(form({ runId: incomplete!.id, olderThanDays: "30" }));

    const runs = await prisma.run.findMany({ orderBy: { startedAt: "asc" } });
    expect(runs).toHaveLength(2);
    expect(runs[1]).toMatchObject({ result: "SUCCESS" });
  });

  it("does nothing for a run that is not the caller's", async () => {
    const first = await seedUser("first@example.test");
    const { installation } = await seedProduct(first.id, {
      inputSchema: [
        { name: "olderThanDays", label: "Older than", type: "number", required: true },
      ],
    });
    await destinationOf(() =>
      runFromWorkspace(form({ installationId: installation.id })),
    );
    const incomplete = await prisma.run.findFirst();

    await seedUser("second@example.test");
    await provideInputs(form({ runId: incomplete!.id, olderThanDays: "30" }));

    expect(await prisma.run.count()).toBe(1);
  });
});

describe("followUp", () => {
  it("asks the orchestrator as the authenticated user, never the thread", async () => {
    // sessionId decides which tools the conversation can see, so it has to be
    // the real user id and nothing the browser could influence.
    const user = await seedUser();
    const thread = await prisma.thread.create({
      data: { userId: user.id, title: "A thread" },
    });

    await followUp(form({ threadId: thread.id, message: "and the week before?" }));

    expect(chatCalls).toEqual([
      { sessionId: user.id, chatInput: "and the week before?" },
    ]);
  });

  it("records both sides of the exchange", async () => {
    const user = await seedUser();
    const thread = await prisma.thread.create({
      data: { userId: user.id, title: "A thread" },
    });

    await followUp(form({ threadId: thread.id, message: "hello" }));

    const messages = await prisma.message.findMany({ orderBy: { createdAt: "asc" } });
    expect(messages.map((m) => [m.role, m.body])).toEqual([
      ["USER", "hello"],
      ["ASSISTANT", "answered hello"],
    ]);
  });

  it("ignores an empty message", async () => {
    const user = await seedUser();
    const thread = await prisma.thread.create({
      data: { userId: user.id, title: "A thread" },
    });

    await followUp(form({ threadId: thread.id, message: "   " }));

    expect(await prisma.message.count()).toBe(0);
    expect(chatCalls).toHaveLength(0);
  });

  it("will not post into someone else's thread", async () => {
    const first = await seedUser("first@example.test");
    const thread = await prisma.thread.create({
      data: { userId: first.id, title: "Theirs" },
    });

    await seedUser("second@example.test");
    await followUp(form({ threadId: thread.id, message: "let me in" }));

    expect(await prisma.message.count()).toBe(0);
    expect(chatCalls).toHaveLength(0);
  });

  it("shows a generic message, not a crash, when the orchestrator is unreachable", async () => {
    const user = await seedUser();
    const thread = await prisma.thread.create({
      data: { userId: user.id, title: "A thread" },
    });
    chatFailure.next = new Error("fetch failed");

    await followUp(form({ threadId: thread.id, message: "hi" }));

    const reply = await prisma.message.findFirst({ where: { role: "ASSISTANT" } });
    expect(reply!.body).toBe(
      "Something went wrong reaching the assistant. Please try again in a moment.",
    );
  });
});
