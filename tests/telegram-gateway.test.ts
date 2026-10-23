import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { prisma } from "@/lib/db";
import { n8n } from "@/lib/n8n";
import { issueTelegramCode, resolveTelegramUser } from "@/server/channel-links";
import { answerMessage } from "@/server/orchestrator/assistant";
import { handleTelegramUpdate, telegramRequestAuthorised, type TelegramDeps } from "@/server/telegram-gateway";
import { POST } from "@/app/api/channels/telegram/webhook/route";

/**
 * The Telegram gateway against the real link tables. Each case uses its own
 * Telegram account id, because the link attempts are counted per account and the
 * counts outlive a single test.
 */

const PLAN_ID = "test-plan";
let nextTelegramId = 7_000_000;
const freshTelegramId = () => String(nextTelegramId++);

async function wipe() {
  await prisma.auditLog.deleteMany({});
  await prisma.channelLink.deleteMany({});
  await prisma.channelLinkCode.deleteMany({});
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

function recordingDeps(answer = "الرد") {
  const sent: { chatId: number; text: string }[] = [];
  const asked: { userId: string; chatInput: string }[] = [];
  const deps: TelegramDeps = {
    answer: async (input) => {
      asked.push(input);
      return answer;
    },
    send: async (chatId, text) => {
      sent.push({ chatId, text });
    },
  };
  return { deps, sent, asked };
}

function message(telegramId: string, text: string) {
  return { message: { text, chat: { id: 555 }, from: { id: Number(telegramId) } } };
}

beforeEach(wipe);
afterAll(async () => {
  await wipe();
  await prisma.$disconnect();
});

describe("handleTelegramUpdate — linking", () => {
  it("links the chat with a valid code and says so", async () => {
    const user = await makeUser("tg-link@example.test");
    const { code } = await issueTelegramCode(user.id);
    const telegramId = freshTelegramId();
    const { deps, sent } = recordingDeps();

    await handleTelegramUpdate(message(telegramId, `/link ${code}`), deps);

    expect(sent).toEqual([
      { chatId: 555, text: "تم ربط حسابك في المنصة. أرسل رسالتك هنا وسيردّ عليك المساعد." },
    ]);
    expect(await resolveTelegramUser(telegramId)).toBe(user.id);
  });

  it("reports the reason when the code is wrong", async () => {
    const { deps, sent } = recordingDeps();

    await handleTelegramUpdate(message(freshTelegramId(), "/link ZZZZZZZZ"), deps);

    expect(sent[0].text).toBe(
      "تعذّر الربط (invalid). أنشئ رمزاً جديداً من صفحة الحسابات وحاول مرة أخرى.",
    );
  });

  it("stops guessing codes from one chat after the allowance", async () => {
    const { deps, sent } = recordingDeps();
    const telegramId = freshTelegramId();

    for (let i = 0; i < 10; i++) {
      await handleTelegramUpdate(message(telegramId, "/link ZZZZZZZZ"), deps);
    }
    await handleTelegramUpdate(message(telegramId, "/link ZZZZZZZZ"), deps);

    expect(sent.at(-1)?.text).toBe("تعذّر الربط (rate_limited). حاول بعد قليل.");
  });
});

describe("handleTelegramUpdate — messages", () => {
  it("answers a linked chat as the linked person", async () => {
    const user = await makeUser("tg-answer@example.test");
    const { code } = await issueTelegramCode(user.id);
    const telegramId = freshTelegramId();
    await handleTelegramUpdate(message(telegramId, `/link ${code}`), recordingDeps().deps);
    const { deps, sent, asked } = recordingDeps("مرحباً بك");

    await handleTelegramUpdate(message(telegramId, "ما أخبار اليوم؟"), deps);

    expect(asked).toEqual([{ userId: user.id, chatInput: "ما أخبار اليوم؟" }]);
    expect(sent).toEqual([{ chatId: 555, text: "مرحباً بك" }]);
  });

  it("asks an unlinked chat to link first, and answers nothing", async () => {
    const { deps, sent, asked } = recordingDeps();

    await handleTelegramUpdate(message(freshTelegramId(), "مرحباً"), deps);

    expect(asked).toHaveLength(0);
    expect(sent[0].text).toContain("/link <الرمز>");
  });

  it("sends a fixed line when the answer is empty", async () => {
    const user = await makeUser("tg-empty@example.test");
    const { code } = await issueTelegramCode(user.id);
    const telegramId = freshTelegramId();
    await handleTelegramUpdate(message(telegramId, `/link ${code}`), recordingDeps().deps);
    const { deps, sent } = recordingDeps("");

    await handleTelegramUpdate(message(telegramId, "hi"), deps);

    expect(sent.at(-1)?.text).toBe("تعذّر الحصول على رد الآن. حاول مرة أخرى.");
  });

  it("ignores updates without text", async () => {
    const { deps, sent, asked } = recordingDeps();

    await handleTelegramUpdate({ message: { chat: { id: 1 }, from: { id: 2 } } }, deps);
    await handleTelegramUpdate({ update_id: 3 }, deps);

    expect(sent).toHaveLength(0);
    expect(asked).toHaveLength(0);
  });

  it("answers through the Orchestrator the environment selects, n8n by default", async () => {
    const chat = vi.spyOn(n8n, "chat").mockResolvedValue({ output: "من n8n" });
    const user = await makeUser("tg-default@example.test");
    const { code } = await issueTelegramCode(user.id);
    const telegramId = freshTelegramId();
    const { deps, sent } = recordingDeps();
    await handleTelegramUpdate(message(telegramId, `/link ${code}`), deps);
    const answering: TelegramDeps = {
      answer: answerMessage,
      send: deps.send,
    };

    await handleTelegramUpdate(message(telegramId, "مرحباً"), answering);

    expect(chat).toHaveBeenCalledWith({ sessionId: user.id, chatInput: "مرحباً" });
    expect(sent.at(-1)?.text).toBe("من n8n");
  });
});

describe("the Telegram webhook route", () => {
  it("refuses an update without the secret", async () => {
    const response = await POST(
      new Request("http://localhost/api/channels/telegram/webhook", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(message("1", "hi")),
      }),
    );
    expect(response.status).toBe(401);
  });

  it("refuses a wrong secret", async () => {
    const request = new Request("http://localhost/api/channels/telegram/webhook", {
      method: "POST",
      headers: { "x-telegram-bot-api-secret-token": "wrong" },
    });
    expect(telegramRequestAuthorised(request)).toBe(false);
  });

  it("accepts the configured secret", async () => {
    const request = new Request("http://localhost/api/channels/telegram/webhook", {
      method: "POST",
      headers: { "x-telegram-bot-api-secret-token": "test-telegram-webhook-secret" },
    });
    expect(telegramRequestAuthorised(request)).toBe(true);
  });
});
