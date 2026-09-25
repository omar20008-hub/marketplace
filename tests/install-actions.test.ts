import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * activate(), the wizard's submit.
 *
 * It is a server action, so three things that only exist inside a request are
 * replaced here: the session, revalidation and the redirect. The redirect is
 * made to throw the way Next's own does, which is also how each test reads the
 * destination the action chose.
 *
 * What is being pinned down is the decision the README calls a platform state:
 * "Install Template rightly refuses an incomplete credential set, so the
 * platform records a PARTIAL installation and only calls the workflow once
 * every connection exists."
 */

const viewer = vi.hoisted(() => ({ current: null as { id: string } | null }));

vi.mock("@/lib/auth", () => ({
  requireUser: async () => {
    if (!viewer.current) throw new Error("no session in this test");
    return viewer.current;
  },
}));

vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

class Redirected extends Error {
  constructor(readonly to: string) {
    super(`redirect:${to}`);
  }
}
vi.mock("next/navigation", () => ({
  redirect: (to: string) => {
    throw new Redirected(to);
  },
}));

const { prisma } = await import("@/lib/db");
const { activate } = await import("@/server/install-actions");
const { openCredential } = await import("@/lib/secrets");

const PLAN_ID = "test-plan-install";

async function wipe() {
  await prisma.installationCredential.deleteMany({});
  await prisma.installation.deleteMany({});
  await prisma.requirement.deleteMany({});
  await prisma.connectedAccount.deleteMany({});
  await prisma.product.deleteMany({});
  await prisma.user.deleteMany({});
  await prisma.plan.deleteMany({});
  await prisma.storageAdapter.deleteMany({});
}

async function seedUser() {
  await prisma.plan.create({
    data: {
      id: PLAN_ID,
      name: "Test",
      monthlyRuns: 100,
      storageBytes: BigInt(1_000_000),
      monthlyCredits: 0,
    },
  });
  const user = await prisma.user.create({
    data: {
      email: "installer@example.test",
      name: "Installer",
      passwordHash: "x",
      initials: "IN",
      planId: PLAN_ID,
    },
  });
  viewer.current = user;
  return user;
}

async function seedAdapters() {
  await prisma.storageAdapter.createMany({
    data: [
      { backend: "platform", displayName: "Platform storage", active: true },
      { backend: "drive", displayName: "Google Drive", active: false },
    ],
  });
}

function productData(
  creatorId: string,
  status: "PUBLISHED" | "RESTRICTED" | "SUSPENDED",
  requirements: {
    kind: "CONNECTION";
    label: string;
    credentialType: string;
    providedBy: "USER" | "PLATFORM";
  }[],
) {
  return {
    slug: `p-${Math.random().toString(36).slice(2, 8)}`,
    creatorId,
    title: "Digest",
    summary: "s",
    description: "d",
    needsFromYou: "n",
    kind: "WORKFLOW" as const,
    category: "Reporting",
    status,
    templateId: `tpl_${Math.random().toString(36).slice(2, 8)}`,
    requirements: { create: requirements },
  };
}

/** Runs the action and reports where it redirected, or what it refused with. */
async function submit(form: Record<string, string>) {
  const data = new FormData();
  for (const [key, value] of Object.entries(form)) data.append(key, value);

  try {
    const state = await activate({}, data);
    return { redirectedTo: null as string | null, ...state };
  } catch (error) {
    if (error instanceof Redirected) {
      return { redirectedTo: error.to, error: undefined };
    }
    throw error;
  }
}

beforeEach(async () => {
  await wipe();
  await seedAdapters();
});

afterAll(async () => {
  await wipe();
  await prisma.$disconnect();
});

describe("activate — what it refuses", () => {
  it("refuses a product that does not exist", async () => {
    await seedUser();
    const result = await submit({ productId: "nope", storageBackend: "platform" });

    expect(result.error).toMatch(/no longer exists/);
  });

  it("refuses a suspended product", async () => {
    const user = await seedUser();
    const product = await prisma.product.create({
      data: productData(user.id, "SUSPENDED", []),
    });

    const result = await submit({
      productId: product.id,
      storageBackend: "platform",
    });

    expect(result.error).toMatch(/not available/);
    expect(await prisma.installation.count()).toBe(0);
  });

  it("explains a restricted product in its own terms", async () => {
    const user = await seedUser();
    const product = await prisma.product.create({
      data: productData(user.id, "RESTRICTED", []),
    });

    const result = await submit({
      productId: product.id,
      storageBackend: "platform",
    });

    expect(result.error).toMatch(/restricted to existing users/);
  });

  it("refuses a storage destination whose adapter is not enabled", async () => {
    const user = await seedUser();
    const product = await prisma.product.create({
      data: productData(user.id, "PUBLISHED", []),
    });

    const result = await submit({ productId: product.id, storageBackend: "drive" });

    expect(result.error).toMatch(/not enabled yet/);
    expect(await prisma.installation.count()).toBe(0);
  });

  it("refuses a destination that has no adapter row at all", async () => {
    const user = await seedUser();
    const product = await prisma.product.create({
      data: productData(user.id, "PUBLISHED", []),
    });

    const result = await submit({ productId: product.id, storageBackend: "s3" });

    expect(result.error).toMatch(/not enabled yet/);
  });
});

describe("activate — partially ready", () => {
  it("records PARTIAL and never calls the workflow when a connection is missing", async () => {
    const user = await seedUser();
    const product = await prisma.product.create({
      data: productData(user.id, "PUBLISHED", [
        {
          kind: "CONNECTION",
          label: "Slack",
          credentialType: "slackApi",
          providedBy: "USER",
        },
      ]),
    });

    const result = await submit({
      productId: product.id,
      storageBackend: "platform",
    });

    expect(result.redirectedTo).toBe("/workspace");
    const installation = await prisma.installation.findFirst();
    expect(installation).toMatchObject({ status: "PARTIAL" });
    // No installationId means MP · Install Template was never called.
    expect(installation!.installationId).toBeNull();
    expect(installation!.attentionNote).toContain("Slack");
  });

  it("names the missing connection the way a person would read it", async () => {
    const user = await seedUser();
    const product = await prisma.product.create({
      data: productData(user.id, "PUBLISHED", [
        {
          kind: "CONNECTION",
          label: "Sheets",
          credentialType: "googleSheetsOAuth2Api",
          providedBy: "USER",
        },
      ]),
    });

    await submit({ productId: product.id, storageBackend: "platform" });

    const installation = await prisma.installation.findFirst();
    expect(installation!.attentionNote).toContain("Google Sheets");
  });

  it("ignores requirements the platform provides", async () => {
    const user = await seedUser();
    const product = await prisma.product.create({
      data: productData(user.id, "PUBLISHED", [
        {
          kind: "CONNECTION",
          label: "AI model",
          credentialType: "openAiApi",
          providedBy: "PLATFORM",
        },
      ]),
    });

    await submit({ productId: product.id, storageBackend: "platform" });

    expect(await prisma.installation.findFirst()).toMatchObject({
      status: "ACTIVE",
    });
  });
});

describe("activate — a completed install", () => {
  const withSlack = (creatorId: string) =>
    productData(creatorId, "PUBLISHED", [
      {
        kind: "CONNECTION",
        label: "Slack",
        credentialType: "slackApi",
        providedBy: "USER",
      },
    ]);

  it("stores the submitted credential encrypted, and installs", async () => {
    const user = await seedUser();
    const product = await prisma.product.create({ data: withSlack(user.id) });

    const result = await submit({
      productId: product.id,
      storageBackend: "platform",
      "cred.slackApi.accessToken": "xoxb-secret-value",
    });

    expect(result.redirectedTo).toBe("/workspace");

    const installation = await prisma.installation.findFirst();
    expect(installation).toMatchObject({ status: "ACTIVE" });
    expect(installation!.installationId).toMatch(/^inst_/);

    const account = await prisma.connectedAccount.findFirst();
    expect(account!.status).toBe("ACTIVE");
    // The plaintext must not be what is in the column.
    expect(account!.secretJson).not.toContain("xoxb-secret-value");
    expect(openCredential(account!.secretJson)).toEqual({
      accessToken: "xoxb-secret-value",
    });
  });

  it("links the installation to the account it used", async () => {
    const user = await seedUser();
    const product = await prisma.product.create({ data: withSlack(user.id) });

    await submit({
      productId: product.id,
      storageBackend: "platform",
      "cred.slackApi.accessToken": "xoxb-1",
    });

    const link = await prisma.installationCredential.findFirst();
    expect(link).toMatchObject({ credentialType: "slackApi" });
    expect(link!.accountId).toBeTruthy();
  });

  it("reuses an account the user already connected", async () => {
    const user = await seedUser();
    await prisma.connectedAccount.create({
      data: {
        userId: user.id,
        credentialType: "slackApi",
        displayName: "Slack",
        initials: "SL",
        status: "ACTIVE",
        secretJson: null,
      },
    });
    const product = await prisma.product.create({ data: withSlack(user.id) });

    const result = await submit({
      productId: product.id,
      storageBackend: "platform",
    });

    expect(result.redirectedTo).toBe("/workspace");
    expect(await prisma.connectedAccount.count()).toBe(1);
    expect(await prisma.installation.findFirst()).toMatchObject({
      status: "ACTIVE",
    });
  });

  it("replaces an expired account in place rather than adding a second one", async () => {
    const user = await seedUser();
    await prisma.connectedAccount.create({
      data: {
        userId: user.id,
        credentialType: "slackApi",
        displayName: "Slack",
        initials: "SL",
        status: "EXPIRED",
        secretJson: null,
      },
    });
    const product = await prisma.product.create({ data: withSlack(user.id) });

    await submit({
      productId: product.id,
      storageBackend: "platform",
      "cred.slackApi.accessToken": "xoxb-fresh",
    });

    const accounts = await prisma.connectedAccount.findMany();
    expect(accounts).toHaveLength(1);
    expect(accounts[0]).toMatchObject({ status: "ACTIVE", expiresAt: null });
    expect(openCredential(accounts[0].secretJson)).toEqual({
      accessToken: "xoxb-fresh",
    });
  });

  it("refuses a credential type the platform cannot collect yet", async () => {
    // Google Sheets needs a consent flow that does not exist, so the mock
    // refuses it exactly as Install Template does. The user should be told,
    // not handed a broken installation.
    const user = await seedUser();
    const product = await prisma.product.create({
      data: productData(user.id, "PUBLISHED", [
        {
          kind: "CONNECTION",
          label: "Sheets",
          credentialType: "googleSheetsOAuth2Api",
          providedBy: "USER",
        },
      ]),
    });

    const result = await submit({
      productId: product.id,
      storageBackend: "platform",
      "cred.googleSheetsOAuth2Api.token": "pretend",
    });

    expect(result.redirectedTo).toBeNull();
    expect(result.error).toMatch(/googleSheetsOAuth2Api/);
    expect(await prisma.installation.count()).toBe(0);
  });

  it("ignores an empty field rather than storing a blank secret", async () => {
    const user = await seedUser();
    const product = await prisma.product.create({ data: withSlack(user.id) });

    await submit({
      productId: product.id,
      storageBackend: "platform",
      "cred.slackApi.accessToken": "",
    });

    expect(await prisma.connectedAccount.count()).toBe(0);
    expect(await prisma.installation.findFirst()).toMatchObject({
      status: "PARTIAL",
    });
  });

  it("pins the installation to the product's current version", async () => {
    const user = await seedUser();
    const product = await prisma.product.create({
      data: { ...productData(user.id, "PUBLISHED", []), version: "4.1" },
    });

    await submit({ productId: product.id, storageBackend: "platform" });

    expect(await prisma.installation.findFirst()).toMatchObject({
      pinnedVersion: "4.1",
    });
  });

  it("completes an installation that was left partially ready", async () => {
    const user = await seedUser();
    const product = await prisma.product.create({ data: withSlack(user.id) });

    await submit({ productId: product.id, storageBackend: "platform" });
    expect(await prisma.installation.findFirst()).toMatchObject({
      status: "PARTIAL",
    });

    await submit({
      productId: product.id,
      storageBackend: "platform",
      "cred.slackApi.accessToken": "xoxb-now",
    });

    const installations = await prisma.installation.findMany();
    expect(installations).toHaveLength(1);
    expect(installations[0]).toMatchObject({
      status: "ACTIVE",
      attentionNote: null,
    });
  });

  it("stores the submitted schedule and the activation status the reply gave", async () => {
    const user = await seedUser();
    const product = await prisma.product.create({
      data: { ...productData(user.id, "PUBLISHED", []), invocationMode: "scheduled" },
    });

    await submit({
      productId: product.id,
      storageBackend: "platform",
      schedule: "0 9 * * *",
    });

    expect(await prisma.installation.findFirst()).toMatchObject({
      status: "ACTIVE",
      schedule: "0 9 * * *",
      activationStatus: "active",
    });
  });

  it("leaves schedule unset when the field is left blank", async () => {
    const user = await seedUser();
    const product = await prisma.product.create({ data: productData(user.id, "PUBLISHED", []) });

    await submit({ productId: product.id, storageBackend: "platform" });

    expect(await prisma.installation.findFirst()).toMatchObject({ schedule: null });
  });
});
