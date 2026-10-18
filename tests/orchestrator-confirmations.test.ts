import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { prisma } from "@/lib/db";
import { argsKey, isAffirmation, NO_CONFIRMATION } from "@/server/orchestrator/confirmations";
import { CONFIRMATION_WINDOW_MS, databaseConfirmations } from "@/server/orchestrator/confirmations-store";

/**
 * The write gate. The pure part decides what counts as a yes; the database part
 * decides whether a yes confirms a proposal the person has actually seen.
 */

const PLAN_ID = "test-plan";
const ARGS = { caption: "مرحباً", networks: "facebook" };

async function wipe() {
  await prisma.orchestratorPendingAction.deleteMany({});
  await prisma.message.deleteMany({});
  await prisma.thread.deleteMany({});
  await prisma.user.deleteMany({});
  await prisma.plan.deleteMany({});
}

async function setup() {
  await prisma.plan.upsert({
    where: { id: PLAN_ID },
    update: {},
    create: { id: PLAN_ID, name: "Test", monthlyRuns: 100, storageBytes: BigInt(1_000_000), monthlyCredits: 0 },
  });
  const user = await prisma.user.create({
    data: { email: "confirm@test.local", name: "Tester", passwordHash: "x", initials: "TE", planId: PLAN_ID },
  });
  const thread = await prisma.thread.create({ data: { userId: user.id, title: "محادثة" } });
  const first = await prisma.message.create({ data: { threadId: thread.id, role: "USER", body: "انشر" } });
  const second = await prisma.message.create({ data: { threadId: thread.id, role: "USER", body: "نعم" } });
  return { user, thread, first, second };
}

describe("isAffirmation", () => {
  it.each(["نعم", "نعم، أكد", "أكد", "تمام.", "yes", "Yes confirm", "ok"])("accepts %s", (message) => {
    expect(isAffirmation(message)).toBe(true);
  });

  it.each(["نعم لكن غيّر الوقت", "لا", "", "ما رأيك في الطقس اليوم؟", "نعم نعم نعم نعم"])("refuses %s", (message) => {
    expect(isAffirmation(message)).toBe(false);
  });
});

describe("argsKey", () => {
  it("is the same whatever order the keys came in", () => {
    expect(argsKey({ a: 1, b: { y: 2, x: 1 } })).toBe(argsKey({ b: { x: 1, y: 2 }, a: 1 }));
  });
});

describe("NO_CONFIRMATION", () => {
  it("confirms nothing", async () => {
    expect(await NO_CONFIRMATION.confirmed("inst", ARGS)).toBe(false);
  });
});

describe("databaseConfirmations", () => {
  beforeEach(wipe);
  afterAll(wipe);

  it("confirms a proposal made in an earlier message, once", async () => {
    const { user, thread, first, second } = await setup();
    await databaseConfirmations({ userId: user.id, threadId: thread.id, currentMessageId: first.id, userMessage: "انشر" }).propose("inst", ARGS);

    const gate = databaseConfirmations({ userId: user.id, threadId: thread.id, currentMessageId: second.id, userMessage: "نعم" });
    expect(await gate.confirmed("inst", ARGS)).toBe(true);
    expect(await gate.confirmed("inst", ARGS)).toBe(false);
  });

  it("does not confirm a proposal made while answering the same message", async () => {
    const { user, thread, first } = await setup();
    const gate = databaseConfirmations({ userId: user.id, threadId: thread.id, currentMessageId: first.id, userMessage: "نعم" });
    await gate.propose("inst", ARGS);
    expect(await gate.confirmed("inst", ARGS)).toBe(false);
  });

  it("needs an affirmative message", async () => {
    const { user, thread, first, second } = await setup();
    await databaseConfirmations({ userId: user.id, threadId: thread.id, currentMessageId: first.id, userMessage: "انشر" }).propose("inst", ARGS);

    const gate = databaseConfirmations({ userId: user.id, threadId: thread.id, currentMessageId: second.id, userMessage: "غيّر النص" });
    expect(await gate.confirmed("inst", ARGS)).toBe(false);
  });

  it("confirms only the exact arguments that were proposed", async () => {
    const { user, thread, first, second } = await setup();
    await databaseConfirmations({ userId: user.id, threadId: thread.id, currentMessageId: first.id, userMessage: "انشر" }).propose("inst", ARGS);

    const gate = databaseConfirmations({ userId: user.id, threadId: thread.id, currentMessageId: second.id, userMessage: "نعم" });
    expect(await gate.confirmed("inst", { ...ARGS, caption: "نص آخر" })).toBe(false);
  });

  it("ignores a proposal older than the confirmation window", async () => {
    const { user, thread, first, second } = await setup();
    await databaseConfirmations({ userId: user.id, threadId: thread.id, currentMessageId: first.id, userMessage: "انشر" }).propose("inst", ARGS);

    const later = new Date(Date.now() + CONFIRMATION_WINDOW_MS + 60_000);
    const gate = databaseConfirmations({ userId: user.id, threadId: thread.id, currentMessageId: second.id, userMessage: "نعم", now: later });
    expect(await gate.confirmed("inst", ARGS)).toBe(false);
  });

  it("confirms nothing for a thread that is not the user's", async () => {
    const { user, thread, first, second } = await setup();
    await databaseConfirmations({ userId: user.id, threadId: thread.id, currentMessageId: first.id, userMessage: "انشر" }).propose("inst", ARGS);

    const gate = databaseConfirmations({ userId: "someone-else", threadId: thread.id, currentMessageId: second.id, userMessage: "نعم" });
    expect(await gate.confirmed("inst", ARGS)).toBe(false);
  });

  it("confirms nothing without a thread to anchor to", async () => {
    const { user } = await setup();
    const gate = databaseConfirmations({ userId: user.id, userMessage: "نعم" });
    await gate.propose("inst", ARGS);
    expect(await gate.confirmed("inst", ARGS)).toBe(false);
  });
});
