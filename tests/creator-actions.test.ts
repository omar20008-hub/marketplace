import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Uploading a product, and the back-and-forth that follows.
 *
 * The safety scan lives inside MP · Upload & Provision; nothing here repeats
 * it. So these tests are about the platform's half: that a rejection writes no
 * product at all, that the reply is recorded faithfully as a submission, and
 * that a creator cannot resubmit past a blocker or an unanswered question.
 */

const viewer = vi.hoisted(() => ({
  current: null as { id: string; roles: string[] } | null,
}));

class Redirected extends Error {
  constructor(readonly to: string) {
    super(`redirect:${to}`);
  }
}

vi.mock("@/lib/auth", () => ({
  requireRole: async (role: string) => {
    if (!viewer.current) throw new Redirected("/login");
    if (!viewer.current.roles.includes(role)) throw new Redirected("/");
    return viewer.current;
  },
}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("next/navigation", () => ({
  redirect: (to: string) => {
    throw new Redirected(to);
  },
}));

const { prisma } = await import("@/lib/db");
const { answerIssue, resubmit, uploadProduct } = await import(
  "@/server/creator-actions"
);

const PLAN_ID = "test-plan-creator";

async function wipe() {
  await prisma.submissionIssue.deleteMany({});
  await prisma.submission.deleteMany({});
  await prisma.productVersion.deleteMany({});
  await prisma.product.deleteMany({});
  await prisma.user.deleteMany({});
  await prisma.plan.deleteMany({});
}

async function seedCreator() {
  await prisma.plan.upsert({
    where: { id: PLAN_ID },
    create: {
      id: PLAN_ID,
      name: "Test",
      monthlyRuns: 10,
      storageBytes: BigInt(1000),
      monthlyCredits: 0,
    },
    update: {},
  });
  const creator = await prisma.user.create({
    data: {
      email: `c${Math.random().toString(36).slice(2, 8)}@example.test`,
      name: "Creator",
      passwordHash: "x",
      initials: "CR",
      planId: PLAN_ID,
      roles: ["USER", "CREATOR"],
    },
  });
  viewer.current = { id: creator.id, roles: ["USER", "CREATOR"] };
  return creator;
}

const trigger = {
  type: "n8n-nodes-base.executeWorkflowTrigger",
  parameters: { inputSource: "workflowInputs" },
};

/** A workflow the mock driver accepts, plus whatever extra nodes are given. */
function workflowFile(...nodes: unknown[]) {
  return new File(
    [JSON.stringify({ nodes: [trigger, ...nodes] })],
    "workflow.json",
    { type: "application/json" },
  );
}

function uploadForm(file: File | null, values: Record<string, string> = {}) {
  const data = new FormData();
  data.append("title", "Weekly Digest");
  data.append("description", "Sends a digest of last week every Monday morning.");
  for (const [key, value] of Object.entries(values)) data.set(key, value);
  if (file) data.append("file", file);
  return data;
}

/** Runs the upload and reports where it redirected, or why it refused. */
async function upload(file: File | null, values: Record<string, string> = {}) {
  try {
    const state = await uploadProduct({}, uploadForm(file, values));
    return { to: null as string | null, error: state.error };
  } catch (error) {
    if (error instanceof Redirected) return { to: error.to, error: undefined };
    throw error;
  }
}

function form(values: Record<string, string>) {
  const data = new FormData();
  for (const [key, value] of Object.entries(values)) data.append(key, value);
  return data;
}

beforeEach(wipe);
afterAll(async () => {
  await wipe();
  await prisma.$disconnect();
});

describe("only a creator uploads", () => {
  it("sends a signed-in non-creator home", async () => {
    await seedCreator();
    viewer.current = { id: "someone", roles: ["USER"] };

    const result = await upload(workflowFile());

    expect(result.to).toBe("/");
    expect(await prisma.product.count()).toBe(0);
  });
});

describe("what upload refuses before n8n is called", () => {
  it.each([
    [{ title: "" }, /title and a description/],
    [{ description: "" }, /title and a description/],
  ])("refuses %o", async (values, message) => {
    await seedCreator();
    const result = await upload(workflowFile(), values as Record<string, string>);

    expect(result.error).toMatch(message);
    expect(await prisma.product.count()).toBe(0);
  });

  it("refuses with no file attached", async () => {
    await seedCreator();
    const result = await upload(null);

    expect(result.error).toMatch(/Attach the exported workflow/);
  });

  it("refuses an empty file", async () => {
    await seedCreator();
    const result = await upload(new File([], "workflow.json"));

    expect(result.error).toMatch(/Attach the exported workflow/);
  });
});

describe("a workflow the scan rejects", () => {
  it("writes no product and no submission, only the reason", async () => {
    await seedCreator();

    const result = await upload(
      workflowFile({ type: "n8n-nodes-base.executeCommand" }),
    );

    expect(result.error).toMatch(/executeCommand/);
    expect(await prisma.product.count()).toBe(0);
    expect(await prisma.submission.count()).toBe(0);
  });

  it("reports a file that is not a workflow at all", async () => {
    await seedCreator();

    const result = await upload(new File(["not json"], "workflow.json"));

    expect(result.error).toMatch(/not valid JSON/);
    expect(await prisma.product.count()).toBe(0);
  });
});

describe("a workflow the scan accepts", () => {
  it("records the product in review, with what the reply said", async () => {
    const creator = await seedCreator();

    const result = await upload(
      workflowFile({
        type: "n8n-nodes-base.slack",
        credentials: { slackApi: { id: "1" } },
        parameters: { url: "https://api.example.com/x" },
      }),
    );

    expect(result.to).toMatch(/^\/creator\?submission=/);

    const product = await prisma.product.findFirst();
    expect(product).toMatchObject({
      slug: "weekly-digest",
      creatorId: creator.id,
      status: "IN_REVIEW",
      credentialDurability: "durable",
      nodeCount: 2,
    });
    expect(product!.templateId).toMatch(/^tpl_/);
    expect(product!.requiredCredentials).toEqual(["slackApi"]);
    expect(product!.externalHosts).toContain("api.example.com");
    expect(product!.needsFromYou).toContain("slackApi");
  });

  it("says nothing is needed when the workflow asks for no account", async () => {
    await seedCreator();
    await upload(workflowFile());

    expect((await prisma.product.findFirst())!.needsFromYou).toMatch(
      /provided by the platform/,
    );
  });

  it("opens a submission under review", async () => {
    await seedCreator();
    await upload(workflowFile());

    expect(await prisma.submission.findFirst()).toMatchObject({
      state: "UNDER_REVIEW",
      parsing: "PASSED",
      secrets: "FIXED",
      compatibility: "PASSED",
      security: "PASSED",
    });
  });

  it("marks a flagged node for a human, and asks the creator about it", async () => {
    await seedCreator();
    await upload(workflowFile({ type: "n8n-nodes-base.code" }));

    expect(await prisma.submission.findFirst()).toMatchObject({
      state: "UNDER_REVIEW",
      security: "HUMAN_REVIEW",
    });
    const issue = await prisma.submissionIssue.findFirst();
    expect(issue).toMatchObject({ severity: "HUMAN_REVIEW", needsAnswer: true });
    expect(issue!.title).toContain("n8n-nodes-base.code");
  });

  it("fails validation, with a blocker, when a connection has no sign-in flow", async () => {
    await seedCreator();

    await upload(
      workflowFile({
        type: "n8n-nodes-base.googleSheets",
        credentials: { googleSheetsOAuth2Api: { id: "1" } },
      }),
    );

    expect(await prisma.submission.findFirst()).toMatchObject({
      state: "VALIDATION_FAILED",
      compatibility: "FAILED",
    });
    expect(await prisma.submissionIssue.findFirst()).toMatchObject({
      severity: "BLOCKER",
    });
  });

  it("bumps the version on a second upload of the same product", async () => {
    await seedCreator();
    await upload(workflowFile());
    await upload(workflowFile());

    const submissions = await prisma.submission.findMany({
      orderBy: { submittedAt: "asc" },
    });
    expect(await prisma.product.count()).toBe(1);
    expect(submissions.map((s) => s.version)).toEqual(["1.0", "1.1"]);
  });
});

describe("answerIssue", () => {
  it("records the creator's answer", async () => {
    await seedCreator();
    await upload(workflowFile({ type: "n8n-nodes-base.code" }));
    const issue = await prisma.submissionIssue.findFirst();

    await answerIssue(form({ issueId: issue!.id, answer: "It formats the dates." }));

    expect(await prisma.submissionIssue.findUnique({ where: { id: issue!.id } })).toMatchObject({
      answer: "It formats the dates.",
    });
  });

  it("ignores a blank answer", async () => {
    await seedCreator();
    await upload(workflowFile({ type: "n8n-nodes-base.code" }));
    const issue = await prisma.submissionIssue.findFirst();

    await answerIssue(form({ issueId: issue!.id, answer: "   " }));

    expect(await prisma.submissionIssue.findUnique({ where: { id: issue!.id } })).toMatchObject({
      answer: null,
    });
  });

  it("will not answer on another creator's submission", async () => {
    await seedCreator();
    await upload(workflowFile({ type: "n8n-nodes-base.code" }));
    const issue = await prisma.submissionIssue.findFirst();

    await seedCreator();
    await answerIssue(form({ issueId: issue!.id, answer: "let me in" }));

    expect(await prisma.submissionIssue.findUnique({ where: { id: issue!.id } })).toMatchObject({
      answer: null,
    });
  });
});

describe("resubmit", () => {
  it("puts an answered submission back under review", async () => {
    await seedCreator();
    await upload(workflowFile({ type: "n8n-nodes-base.code" }));
    const submission = await prisma.submission.findFirst();
    const issue = await prisma.submissionIssue.findFirst();

    await answerIssue(form({ issueId: issue!.id, answer: "It formats the dates." }));
    await prisma.submission.update({
      where: { id: submission!.id },
      data: { state: "CHANGES_REQUESTED" },
    });

    await resubmit(form({ submissionId: submission!.id }));

    expect(await prisma.submission.findUnique({ where: { id: submission!.id } })).toMatchObject({
      state: "UNDER_REVIEW",
    });
  });

  it("refuses while a question is unanswered", async () => {
    await seedCreator();
    await upload(workflowFile({ type: "n8n-nodes-base.code" }));
    const submission = await prisma.submission.findFirst();
    await prisma.submission.update({
      where: { id: submission!.id },
      data: { state: "CHANGES_REQUESTED" },
    });

    await resubmit(form({ submissionId: submission!.id }));

    expect(await prisma.submission.findUnique({ where: { id: submission!.id } })).toMatchObject({
      state: "CHANGES_REQUESTED",
    });
  });

  it("refuses while a blocker stands, however the creator answers", async () => {
    await seedCreator();
    await upload(
      workflowFile({
        type: "n8n-nodes-base.googleSheets",
        credentials: { googleSheetsOAuth2Api: { id: "1" } },
      }),
    );
    const submission = await prisma.submission.findFirst();

    await resubmit(form({ submissionId: submission!.id }));

    expect(await prisma.submission.findUnique({ where: { id: submission!.id } })).toMatchObject({
      state: "VALIDATION_FAILED",
    });
  });

  it("will not resubmit another creator's submission", async () => {
    await seedCreator();
    await upload(workflowFile());
    const submission = await prisma.submission.findFirst();
    await prisma.submission.update({
      where: { id: submission!.id },
      data: { state: "CHANGES_REQUESTED" },
    });

    await seedCreator();
    await resubmit(form({ submissionId: submission!.id }));

    expect(await prisma.submission.findUnique({ where: { id: submission!.id } })).toMatchObject({
      state: "CHANGES_REQUESTED",
    });
  });
});
