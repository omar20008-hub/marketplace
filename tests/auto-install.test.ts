import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Giving a new person the products that work for them without a connection of
 * their own. installCopy (the n8n build) is replaced by a spy; everything else,
 * including the choice of products and the rows written, runs against Postgres.
 */

const state = vi.hoisted(() => ({
  install: vi.fn(),
  platformKey: vi.fn(),
}));

vi.mock("@/server/install-copy", () => ({ installCopy: state.install }));
vi.mock("@/lib/platform-secrets", () => ({ platformCredential: state.platformKey }));
vi.mock("server-only", () => ({}));

const { prisma } = await import("@/lib/db");
const { installReadyProducts } = await import("@/server/auto-install");

const PLAN_ID = "auto-install-plan";

async function wipe() {
  await prisma.installationCredential.deleteMany({});
  await prisma.installation.deleteMany({});
  await prisma.requirement.deleteMany({});
  await prisma.product.deleteMany({});
  await prisma.user.deleteMany({});
  await prisma.plan.deleteMany({});
}

async function setup() {
  await prisma.plan.upsert({
    where: { id: PLAN_ID },
    update: {},
    create: { id: PLAN_ID, name: "Test", monthlyRuns: 100, storageBytes: BigInt(1_000_000), monthlyCredits: 0 },
  });
  await prisma.storageAdapter.upsert({
    where: { backend: "platform" },
    update: { active: true },
    create: { backend: "platform", displayName: "Platform storage", active: true },
  });
  const creator = await prisma.user.create({
    data: { email: `creator-${Math.random()}@test.local`, name: "C", passwordHash: "x", initials: "C", planId: PLAN_ID },
  });
  const person = await prisma.user.create({
    data: { email: `person-${Math.random()}@test.local`, name: "P", passwordHash: "x", initials: "P", planId: PLAN_ID },
  });
  return { creator, person };
}

async function product(
  creatorId: string,
  title: string,
  opts: {
    status?: "PUBLISHED" | "RESTRICTED";
    usesKnowledge?: boolean;
    requiredCredentials?: string[];
    requirements?: { credentialType: string; providedBy: "USER" | "PLATFORM" }[];
  } = {},
) {
  const slug = `ai-${Math.random().toString(36).slice(2, 10)}`;
  return prisma.product.create({
    data: {
      slug,
      creatorId,
      title,
      summary: "s",
      description: "d",
      needsFromYou: "n",
      kind: "WORKFLOW",
      category: "Reporting",
      status: opts.status ?? "PUBLISHED",
      templateId: `tpl-${slug}`,
      n8nWorkflowId: `wf-${slug}`,
      usesKnowledge: opts.usesKnowledge ?? false,
      requiredCredentials: opts.requiredCredentials ?? [],
      inputSchema: [] as never,
      requirements: {
        create: (opts.requirements ?? []).map((r, i) => ({
          kind: "CONNECTION" as const,
          label: r.credentialType,
          credentialType: r.credentialType,
          providedBy: r.providedBy,
          sortOrder: i,
        })),
      },
    },
  });
}

beforeEach(async () => {
  await wipe();
  state.install.mockReset();
  state.platformKey.mockReset();
  state.install.mockImplementation(async (input: { templateId: string }) => ({
    ok: true,
    installationId: `inst-${input.templateId}`,
    instanceWorkflowId: `copy-${input.templateId}`,
    activationStatus: "active",
    n8nCredentialIds: [],
  }));
  state.platformKey.mockResolvedValue({ apiKey: "key-value" });
});
afterAll(async () => {
  await wipe();
  await prisma.$disconnect();
});

describe("installReadyProducts", () => {
  it("installs a published product that needs nothing from the person", async () => {
    const { creator, person } = await setup();
    const digest = await product(creator.id, "Digest");

    const result = await installReadyProducts(person.id);

    expect(result.installed).toHaveLength(1);
    const row = await prisma.installation.findUniqueOrThrow({
      where: { userId_productId: { userId: person.id, productId: digest.id } },
    });
    expect(row.status).toBe("ACTIVE");
    expect(row.storageBackend).toBe("platform");
  });

  it("leaves out a product that needs a connection the person has not made", async () => {
    const { creator, person } = await setup();
    await product(creator.id, "Needs Gmail", {
      requirements: [{ credentialType: "gmailOAuth2", providedBy: "USER" }],
    });

    const result = await installReadyProducts(person.id);

    expect(result.installed).toHaveLength(0);
    expect(state.install).not.toHaveBeenCalled();
  });

  it("gives a platform key to a product that needs one, and sends it to the install", async () => {
    const { creator, person } = await setup();
    await product(creator.id, "Gemini Tool", {
      requirements: [{ credentialType: "googlePalmApi", providedBy: "PLATFORM" }],
    });

    await installReadyProducts(person.id);

    expect(state.platformKey).toHaveBeenCalledWith("googlePalmApi");
    const sent = state.install.mock.calls[0][0] as { credentialsJson: string; storageBackend: string };
    expect(JSON.parse(sent.credentialsJson)).toEqual({ googlePalmApi: { apiKey: "key-value" } });
    expect(sent.storageBackend).toBe("platform");
  });

  it("skips a product whose platform key is not set, without an install", async () => {
    const { creator, person } = await setup();
    await product(creator.id, "Unkeyed", {
      requirements: [{ credentialType: "googlePalmApi", providedBy: "PLATFORM" }],
    });
    state.platformKey.mockResolvedValue(null);

    const result = await installReadyProducts(person.id);

    expect(result.installed).toHaveLength(0);
    expect(state.install).not.toHaveBeenCalled();
  });

  it("leaves out products that need a folder, and restricted ones", async () => {
    const { creator, person } = await setup();
    await product(creator.id, "Needs a folder", { usesKnowledge: true });
    await product(creator.id, "Restricted", { status: "RESTRICTED" });

    const result = await installReadyProducts(person.id);

    expect(result.installed).toHaveLength(0);
  });

  it("does not install again what the person already has", async () => {
    const { creator, person } = await setup();
    const digest = await product(creator.id, "Digest");
    await prisma.installation.create({
      data: {
        installationId: "already",
        userId: person.id,
        productId: digest.id,
        pinnedVersion: "1.0",
        storageBackend: "platform",
        status: "ACTIVE",
      },
    });

    await installReadyProducts(person.id);

    expect(state.install).not.toHaveBeenCalled();
  });

  it("keeps going when one product's build is refused", async () => {
    const { creator, person } = await setup();
    await product(creator.id, "First");
    await product(creator.id, "Second");
    state.install
      .mockResolvedValueOnce({ ok: false, errorText: "n8n is busy" })
      .mockImplementation(async (input: { templateId: string }) => ({
        ok: true,
        installationId: `inst-${input.templateId}`,
        instanceWorkflowId: `copy-${input.templateId}`,
        activationStatus: "active",
        n8nCredentialIds: [],
      }));

    const result = await installReadyProducts(person.id);

    expect(state.install).toHaveBeenCalledTimes(2);
    expect(result.installed).toHaveLength(1);
  });

  it("does nothing while the platform storage is not active", async () => {
    const { creator, person } = await setup();
    await product(creator.id, "Digest");
    await prisma.storageAdapter.update({ where: { backend: "platform" }, data: { active: false } });

    await installReadyProducts(person.id);

    expect(state.install).not.toHaveBeenCalled();
  });
});
