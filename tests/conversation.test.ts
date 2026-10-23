import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * One conversation per person whichever channel it happens on: WhatsApp turns are
 * kept in the platform, every message reaches the orchestrator with the recent
 * turns in front of it (so the personal assistant it hands a message to knows
 * what was said), saved files carry a short-lived link to the original, and an
 * agent key reads the same context.
 */

const viewer = vi.hoisted(() => ({ current: null as { id: string } | null }));
vi.mock("@/lib/auth", () => ({
  currentUser: async () => viewer.current,
  requireUser: async () => {
    if (!viewer.current) throw new Error("redirect:/login");
    return viewer.current;
  },
}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/server/files/ocr", () => ({ defaultOcr: async () => null }));
const chatCalls: { sessionId: string; chatInput: string }[] = [];
vi.mock("@/lib/n8n", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/n8n")>();
  return {
    ...actual,
    n8n: {
      ...actual.n8n,
      chat: async (input: { sessionId: string; chatInput: string }) => {
        chatCalls.push(input);
        return { output: "reply" };
      },
    },
  };
});

const { prisma } = await import("@/lib/db");
const files = await import("@/server/files/user-files");
const { fileDownloadUrl } = await import("@/server/files/file-links");
const { issueAgentKey } = await import("@/server/agent-keys");
const { POST: context } = await import("@/app/api/channels/whatsapp/context/route");
const { POST: reply } = await import("@/app/api/channels/whatsapp/reply/route");
const { GET: download } = await import("@/app/api/files/[id]/download/route");
const { GET: agentContext } = await import("@/app/api/agent/context/route");
const { followUp } = await import("@/server/thread-actions");

const enc = (text: string) => new TextEncoder().encode(text);
const NUMBER = "966500000002";
const headers = { "x-channel-token": "test-channel-token", "content-type": "application/json" };

async function user(email: string) {
  await prisma.plan.upsert({
    where: { id: "conv-plan" },
    update: {},
    create: { id: "conv-plan", name: "T", monthlyRuns: 100, storageBytes: BigInt(1), monthlyCredits: 0 },
  });
  return prisma.user.create({ data: { email, name: "C", passwordHash: "x", initials: "C", planId: "conv-plan" } });
}

async function linked() {
  const owner = await user("w@example.test");
  await prisma.channelLink.create({ data: { userId: owner.id, channel: "whatsapp", externalId: NUMBER } });
  return owner;
}

const ask = (text: string, chatInput = text) =>
  context(
    new Request("http://localhost/api/channels/whatsapp/context", {
      method: "POST",
      headers,
      body: JSON.stringify({ whatsappUserId: NUMBER, text, chatInput }),
    }),
  );

const answer = (text: string) =>
  reply(
    new Request("http://localhost/api/channels/whatsapp/reply", {
      method: "POST",
      headers,
      body: JSON.stringify({ whatsappUserId: NUMBER, reply: text }),
    }),
  );

async function wipe() {
  await prisma.userFile.deleteMany({});
  await prisma.agentKey.deleteMany({});
  await prisma.channelLink.deleteMany({});
  await prisma.message.deleteMany({});
  await prisma.thread.deleteMany({});
  await prisma.memoryFile.deleteMany({});
  await prisma.user.deleteMany({});
  await prisma.plan.deleteMany({});
}

beforeEach(async () => {
  viewer.current = null;
  chatCalls.length = 0;
  await wipe();
});
afterAll(async () => {
  await wipe();
  await prisma.$disconnect();
});

describe("the WhatsApp conversation", () => {
  it("is kept in the platform, and each message carries the turns before it", async () => {
    const owner = await linked();

    const first = await (await ask("اطّلع على المرفق.", 'اطّلع على المرفق.\n\n[The user attached the file "cv.pdf" (PDF). …]')).json();
    expect(first.chatInput).not.toContain("آخر المحادثة");
    expect((await answer("استلمت السيرة الذاتية.")).status).toBe(200);

    const second = await (await ask("قدّم على الوظيفة")).json();
    expect(second.chatInput).toContain("[آخر المحادثة مع المستخدم");
    expect(second.chatInput).toContain("المستخدم: اطّلع على المرفق.\nAttached file: cv.pdf");
    expect(second.chatInput).toContain("المساعد: استلمت السيرة الذاتية.");
    expect(second.chatInput.endsWith("قدّم على الوظيفة")).toBe(true);

    const thread = await prisma.thread.findFirstOrThrow({ where: { userId: owner.id, channel: "whatsapp" } });
    const stored = await prisma.message.findMany({ where: { threadId: thread.id }, orderBy: { createdAt: "asc" } });
    // Only what was typed (and the file's name) is stored, never the file text or the added blocks.
    expect(stored.map((m) => [m.role, m.body])).toEqual([
      ["USER", "اطّلع على المرفق.\nAttached file: cv.pdf"],
      ["ASSISTANT", "استلمت السيرة الذاتية."],
      ["USER", "قدّم على الوظيفة"],
    ]);
  });

  it("refuses the reply call without the channel token or for a number that is not linked", async () => {
    await linked();
    const noToken = await reply(
      new Request("http://localhost/x", { method: "POST", body: JSON.stringify({ whatsappUserId: NUMBER, reply: "x" }) }),
    );
    expect(noToken.status).toBe(401);
    const stranger = await reply(
      new Request("http://localhost/x", {
        method: "POST",
        headers,
        body: JSON.stringify({ whatsappUserId: "966500000099", reply: "x" }),
      }),
    );
    expect(stranger.status).toBe(404);
  });
});

describe("the platform chat", () => {
  it("puts the thread's earlier turns in front of a follow-up", async () => {
    const owner = await user("p@example.test");
    viewer.current = owner;
    const thread = await prisma.thread.create({
      data: {
        userId: owner.id,
        title: "t",
        messages: { create: [{ role: "USER", body: "هذه سيرتي" }, { role: "ASSISTANT", body: "تم الاستلام" }] },
      },
    });
    const data = new FormData();
    data.set("threadId", thread.id);
    data.set("message", "قدّم بها");
    await followUp(data);
    expect(chatCalls[0].chatInput).toContain("المستخدم: هذه سيرتي\nالمساعد: تم الاستلام");
    expect(chatCalls[0].chatInput).not.toContain("المستخدم: قدّم بها");
  });
});

describe("links to saved files", () => {
  async function saved(owner: { id: string }) {
    const file = await files.saveUserFile({ userId: owner.id, fileName: "cv.txt", bytes: enc("my cv"), channel: "whatsapp" });
    if (!file.ok) throw new Error(file.error);
    return file;
  }

  it("are listed with the person's files and download the original", async () => {
    const owner = await linked();
    const file = await saved(owner);
    const { chatInput } = await (await ask("hello")).json();
    const link = /تنزيل الملف الأصلي: (\S+)/.exec(chatInput)?.[1];
    expect(link).toMatch(new RegExp(`^https?://[^/]+/api/files/${file.id}/download\\?exp=\\d+&sig=`));

    const res = await download(new Request(link!), { params: Promise.resolve({ id: file.id }) });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-disposition")).toContain("attachment");
    expect(await res.text()).toBe("my cv");
  });

  it("do not open another file, a tampered link or an expired one", async () => {
    const owner = await linked();
    const file = await saved(owner);
    const other = await saved(owner);
    const link = new URL(fileDownloadUrl(file.id, "http://localhost")!);
    const get = (url: string, id: string) => download(new Request(url), { params: Promise.resolve({ id }) });

    expect((await get(link.toString().replace(file.id, other.id), other.id)).status).toBe(404);
    const sig = link.searchParams.get("sig")!;
    link.searchParams.set("sig", (sig[0] === "x" ? "y" : "x") + sig.slice(1));
    expect((await get(link.toString(), file.id)).status).toBe(404);
    const expired = fileDownloadUrl(file.id, "http://localhost", Date.now() - 3 * 60 * 60 * 1000)!;
    expect((await get(expired, file.id)).status).toBe(404);
  });
});

describe("GET /api/agent/context", () => {
  it("gives an agent key its own person's memory, conversation and files, and nobody else's", async () => {
    const owner = await linked();
    await prisma.memoryFile.create({ data: { userId: owner.id, name: "Profile", content: "- Senior product manager" } });
    await files.saveUserFile({ userId: owner.id, fileName: "cv.txt", bytes: enc("Product roadmap and discovery"), channel: "whatsapp" });
    await ask("قدّم على الوظيفة");
    await answer("في أي مدينة؟");
    const other = await user("o@example.test");
    const otherKey = await issueAgentKey(other.id);
    const key = await issueAgentKey(owner.id);

    const res = await agentContext(
      new Request("http://localhost/api/agent/context?q=roadmap", { headers: { authorization: `Bearer ${key}` } }),
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.memory).toContain("Senior product manager");
    expect(body.conversation.map((t: { role: string; text: string }) => [t.role, t.text])).toEqual([
      ["user", "قدّم على الوظيفة"],
      ["assistant", "في أي مدينة؟"],
    ]);
    expect(body.conversation[0].channel).toBe("whatsapp");
    expect(body.files[0]).toMatchObject({ name: "cv.txt", readable: true });
    expect(body.files[0].downloadUrl).toContain("/download?exp=");
    expect(body.passages[0].text).toContain("roadmap");

    const theirs = await (
      await agentContext(new Request("http://localhost/api/agent/context", { headers: { authorization: `Bearer ${otherKey}` } }))
    ).json();
    expect(theirs.files).toEqual([]);
    expect(theirs.conversation).toEqual([]);
    expect((await agentContext(new Request("http://localhost/api/agent/context"))).status).toBe(401);
  });
});
