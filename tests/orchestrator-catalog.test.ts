import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { prisma } from "@/lib/db";
import { renderCatalog, toolCatalog } from "@/server/orchestrator/catalog";

/**
 * The Orchestrator's tool catalog against a real database. These cases pin the
 * filters that decide what the model is allowed to call: another user's
 * installations, anything not active, a product that is not published, a
 * product that only runs on its own, and the fields it has to ask for.
 */

const PLAN_ID = "test-plan";

async function wipe() {
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
  });
}

async function makeProduct({
  creatorId,
  title = "Weekly Digest",
  description = "Summarises the week",
  actionType = "READ",
  status = "PUBLISHED",
  invocationMode = "on_demand",
  inputSchema = [],
}: {
  creatorId: string;
  title?: string;
  description?: string;
  actionType?: "READ" | "WRITE";
  status?: "PUBLISHED" | "DRAFT" | "SUSPENDED";
  invocationMode?: string;
  inputSchema?: unknown[];
}) {
  return prisma.product.create({
    data: {
      slug: `p-${Math.random().toString(36).slice(2, 10)}`,
      creatorId,
      title,
      summary: "s",
      description,
      needsFromYou: "n",
      kind: "WORKFLOW",
      category: "Reporting",
      actionType,
      status,
      invocationMode,
      inputSchema: inputSchema as never,
    },
  });
}

async function install(
  userId: string,
  productId: string,
  status: "ACTIVE" | "PARTIAL" | "DISABLED" | "UNINSTALLED" = "ACTIVE",
) {
  return prisma.installation.create({
    data: { userId, productId, pinnedVersion: "1.0", status },
  });
}

beforeEach(wipe);
afterAll(async () => {
  await wipe();
  await prisma.$disconnect();
});

describe("toolCatalog", () => {
  it("lists only the caller's active installations of published on-demand products", async () => {
    const user = await makeUser("catalog-owner@example.test");
    const other = await makeUser("catalog-other@example.test");
    const product = await makeProduct({ creatorId: user.id });

    const mine = await install(user.id, product.id, "ACTIVE");
    await install(other.id, product.id, "ACTIVE");

    const entries = await toolCatalog(user.id);

    expect(entries.map((entry) => entry.installationId)).toEqual([mine.id]);
  });

  it("skips installations that are not active", async () => {
    const user = await makeUser("catalog-status@example.test");
    const product = await makeProduct({ creatorId: user.id });
    await install(user.id, product.id, "PARTIAL");

    expect(await toolCatalog(user.id)).toEqual([]);
  });

  it("skips products that are not published", async () => {
    const user = await makeUser("catalog-draft@example.test");
    const draft = await makeProduct({ creatorId: user.id, status: "DRAFT" });
    const suspended = await makeProduct({ creatorId: user.id, status: "SUSPENDED" });
    await install(user.id, draft.id);
    await install(user.id, suspended.id);

    expect(await toolCatalog(user.id)).toEqual([]);
  });

  it("skips a product that runs only on its own schedule", async () => {
    const user = await makeUser("catalog-scheduled@example.test");
    const product = await makeProduct({ creatorId: user.id, invocationMode: "scheduled" });
    await install(user.id, product.id);

    expect(await toolCatalog(user.id)).toEqual([]);
  });

  it("keeps a product that is on-demand alongside another trigger", async () => {
    const user = await makeUser("catalog-composite@example.test");
    const product = await makeProduct({ creatorId: user.id, invocationMode: "on_demand,event" });
    const installation = await install(user.id, product.id);

    const entries = await toolCatalog(user.id);

    expect(entries.map((entry) => entry.installationId)).toEqual([installation.id]);
  });

  it("drops system fields and types a field with no type as string", async () => {
    const user = await makeUser("catalog-fields@example.test");
    const product = await makeProduct({
      creatorId: user.id,
      inputSchema: [
        { name: "chatInput", label: "Input", type: "string", required: true },
        { name: "folder", label: "Folder" },
        { name: "internalToken", label: "Token", type: "string", system: true },
      ],
    });
    await install(user.id, product.id);

    const [entry] = await toolCatalog(user.id);

    expect(entry.fields).toEqual(["chatInput (string)", "folder (string)"]);
  });

  it("maps the action type to the words the prompt uses", async () => {
    const user = await makeUser("catalog-action@example.test");
    const product = await makeProduct({ creatorId: user.id, actionType: "WRITE" });
    await install(user.id, product.id);

    const [entry] = await toolCatalog(user.id);

    expect(entry.actionType).toBe("write");
  });
});

describe("renderCatalog", () => {
  it("says so when there is nothing to call", () => {
    expect(renderCatalog([])).toBe("لا توجد أدوات مفعّلة لهذا المستخدم.");
  });

  it("renders one line per tool in the format the system prompt expects", () => {
    const text = renderCatalog([
      {
        installationId: "inst_1",
        title: "Weekly Digest",
        description: "Summarises the week",
        actionType: "read",
        fields: ["chatInput (string)"],
      },
      {
        installationId: "inst_2",
        title: "Post",
        description: "Publishes",
        actionType: "write",
        fields: [],
      },
    ]);

    expect(text).toBe(
      "- installationId: inst_1 | الاسم: Weekly Digest | متى يُستخدم: Summarises the week | نوع الإجراء: read | الحقول المطلوبة: chatInput (string)\n" +
        "- installationId: inst_2 | الاسم: Post | متى يُستخدم: Publishes | نوع الإجراء: write | الحقول المطلوبة: لا يوجد",
    );
  });
});
