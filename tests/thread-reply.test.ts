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
vi.mock("@/lib/n8n", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/n8n")>();
  return { ...actual, n8n: { ...actual.n8n, chat: async (i: { chatInput: string }) => ({ output: `answered ${i.chatInput}` }) } };
});

const { prisma } = await import("@/lib/db");
const { startTask } = await import("@/server/run-actions");
const { followUp } = await import("@/server/thread-actions");

async function wipe() {
  await prisma.message.deleteMany({});
  await prisma.thread.deleteMany({});
  await prisma.user.deleteMany({});
  await prisma.plan.deleteMany({});
}

beforeEach(async () => {
  await wipe();
  deferred.length = 0;
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
});
