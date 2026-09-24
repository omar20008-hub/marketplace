import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Connected accounts.
 *
 * Two promises are being held to here. The module's own: a secret is encrypted
 * before it touches the database and never read back out. And the workspace's:
 * a product whose connection just came back stops asking for attention, and one
 * whose connection just went says so before the next scheduled run fails.
 */

const viewer = vi.hoisted(() => ({
  current: null as { id: string; email: string } | null,
}));

vi.mock("@/lib/auth", () => ({
  requireUser: async () => {
    if (!viewer.current) throw new Error("no session in this test");
    return viewer.current;
  },
}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

const { prisma } = await import("@/lib/db");
const { openCredential } = await import("@/lib/secrets");
const { connectAccount, disconnectAccount } = await import(
  "@/server/account-actions"
);

const PLAN_ID = "test-plan-accounts";

async function wipe() {
  await prisma.installationCredential.deleteMany({});
  await prisma.installation.deleteMany({});
  await prisma.requirement.deleteMany({});
  await prisma.connectedAccount.deleteMany({});
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
      monthlyRuns: 10,
      storageBytes: BigInt(1000),
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
  });
  viewer.current = user;
  return user;
}

/** A product needing Slack, already installed for this user. */
async function seedInstallation(userId: string, status: "ACTIVE" | "PARTIAL") {
  const product = await prisma.product.create({
    data: {
      slug: `p-${Math.random().toString(36).slice(2, 8)}`,
      creatorId: userId,
      title: "Digest",
      summary: "s",
      description: "d",
      needsFromYou: "n",
      kind: "WORKFLOW",
      category: "Reporting",
      status: "PUBLISHED",
      requirements: {
        create: [
          {
            kind: "CONNECTION",
            label: "Slack",
            credentialType: "slackApi",
            providedBy: "USER",
          },
        ],
      },
    },
  });
  return prisma.installation.create({
    data: {
      userId,
      productId: product.id,
      pinnedVersion: "1.0",
      status,
      installationId: `inst_${Math.random().toString(36).slice(2, 8)}`,
      attentionNote: status === "PARTIAL" ? "Slack still needs connecting." : null,
    },
  });
}

function form(values: Record<string, string>) {
  const data = new FormData();
  for (const [key, value] of Object.entries(values)) data.append(key, value);
  return data;
}

const slack = (extra: Record<string, string> = {}) =>
  form({
    credentialType: "slackApi",
    displayName: "Slack",
    "field.accessToken": "xoxb-secret-value",
    ...extra,
  });

beforeEach(wipe);
afterAll(async () => {
  await wipe();
  await prisma.$disconnect();
});

describe("connectAccount", () => {
  it("stores the secret encrypted, never as plaintext", async () => {
    const user = await seedUser();

    const state = await connectAccount({}, slack());

    expect(state).toEqual({ done: true });
    const account = await prisma.connectedAccount.findFirst();
    expect(account).toMatchObject({
      userId: user.id,
      credentialType: "slackApi",
      status: "ACTIVE",
      accountRef: user.email,
    });
    expect(account!.secretJson).not.toContain("xoxb-secret-value");
    expect(openCredential(account!.secretJson)).toEqual({
      accessToken: "xoxb-secret-value",
    });
  });

  it("takes only the field.* entries, not the whole form", async () => {
    await seedUser();

    await connectAccount({}, slack({ "field.teamId": "T1", notAField: "ignored" }));

    expect(openCredential((await prisma.connectedAccount.findFirst())!.secretJson)).toEqual({
      accessToken: "xoxb-secret-value",
      teamId: "T1",
    });
  });

  it("uses an account reference from the form when one is given", async () => {
    await seedUser();

    await connectAccount({}, slack({ "field.accountRef": "acme.slack.com" }));

    expect(await prisma.connectedAccount.findFirst()).toMatchObject({
      accountRef: "acme.slack.com",
    });
  });

  it("records whether the connection may serve every product", async () => {
    await seedUser();

    await connectAccount({}, slack({ reusable: "this" }));
    expect(await prisma.connectedAccount.findFirst()).toMatchObject({ reusable: false });
  });

  it("refuses with no service named", async () => {
    await seedUser();

    const state = await connectAccount({}, form({ "field.accessToken": "x" }));

    expect(state.error).toMatch(/Pick a service/);
    expect(await prisma.connectedAccount.count()).toBe(0);
  });

  it("refuses when every field is blank, rather than storing an empty secret", async () => {
    await seedUser();

    const state = await connectAccount(
      {},
      form({ credentialType: "slackApi", "field.accessToken": "" }),
    );

    expect(state.error).toMatch(/Fill in the connection details/);
    expect(await prisma.connectedAccount.count()).toBe(0);
  });

  it("replaces the secret on a reconnect rather than adding a second row", async () => {
    await seedUser();
    await connectAccount({}, slack());
    await connectAccount({}, slack({ "field.accessToken": "xoxb-rotated" }));

    const accounts = await prisma.connectedAccount.findMany();
    expect(accounts).toHaveLength(1);
    expect(openCredential(accounts[0].secretJson)).toEqual({
      accessToken: "xoxb-rotated",
    });
  });

  it("clears an expiry when the connection is renewed", async () => {
    const user = await seedUser();
    await prisma.connectedAccount.create({
      data: {
        userId: user.id,
        credentialType: "slackApi",
        displayName: "Slack",
        initials: "SL",
        accountRef: user.email,
        status: "EXPIRED",
        expiresAt: new Date("2020-01-01"),
      },
    });

    await connectAccount({}, slack());

    expect(await prisma.connectedAccount.findFirst()).toMatchObject({
      status: "ACTIVE",
      expiresAt: null,
    });
  });
});

describe("connecting clears the attention it was blocking", () => {
  it("turns a partial installation active again", async () => {
    const user = await seedUser();
    const installation = await seedInstallation(user.id, "PARTIAL");

    await connectAccount({}, slack());

    expect(await prisma.installation.findUnique({ where: { id: installation.id } })).toMatchObject(
      { status: "ACTIVE", attentionNote: null },
    );
  });
});

describe("disconnectAccount", () => {
  it("drops the stored secret and marks the connection pending", async () => {
    await seedUser();
    await connectAccount({}, slack());
    const account = await prisma.connectedAccount.findFirst();

    await disconnectAccount(form({ accountId: account!.id }));

    const after = await prisma.connectedAccount.findUnique({ where: { id: account!.id } });
    expect(after).toMatchObject({ status: "PENDING" });
    // The bytes are gone, not merely marked unusable.
    expect(after!.secretJson).toBeNull();
  });

  it("makes the workspace say so before the next run fails", async () => {
    const user = await seedUser();
    await connectAccount({}, slack());
    const installation = await seedInstallation(user.id, "ACTIVE");
    const account = await prisma.connectedAccount.findFirst();

    await disconnectAccount(form({ accountId: account!.id }));

    const after = await prisma.installation.findUnique({ where: { id: installation.id } });
    expect(after).toMatchObject({ status: "PARTIAL" });
    expect(after!.attentionNote).toContain("Slack");
  });

  it("will not disconnect someone else's account", async () => {
    await seedUser("first@example.test");
    await connectAccount({}, slack());
    const account = await prisma.connectedAccount.findFirst();

    await seedUser("second@example.test");
    await disconnectAccount(form({ accountId: account!.id }));

    expect(await prisma.connectedAccount.findUnique({ where: { id: account!.id } })).toMatchObject(
      { status: "ACTIVE" },
    );
  });

  it("will not disconnect one the platform provides", async () => {
    // It is not the user's to revoke, and other people depend on it.
    const user = await seedUser();
    const account = await prisma.connectedAccount.create({
      data: {
        userId: user.id,
        credentialType: "openAiApi",
        displayName: "AI model",
        initials: "AI",
        scope: "PLATFORM",
        status: "ACTIVE",
        secretJson: "sealed",
      },
    });

    await disconnectAccount(form({ accountId: account.id }));

    expect(await prisma.connectedAccount.findUnique({ where: { id: account.id } })).toMatchObject(
      { status: "ACTIVE", secretJson: "sealed" },
    );
  });

  it("does nothing for an account that does not exist", async () => {
    await seedUser();
    await expect(disconnectAccount(form({ accountId: "nope" }))).resolves.toBeUndefined();
  });
});
