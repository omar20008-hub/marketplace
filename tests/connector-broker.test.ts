import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The token endpoint a template calls with its installation's key. It must answer
 * only for a connection that installation was built with, and only to that key.
 */

const asanaSettings = vi.hoisted(() => ({ clientId: "asana-client", clientSecret: "asana-secret" }));
vi.mock("@/lib/env", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/env")>();
  return {
    ...actual,
    env: {
      ...actual.env,
      get asana() {
        return asanaSettings;
      },
    },
  };
});

const { prisma } = await import("@/lib/db");
const { POST } = await import("@/app/api/connectors/token/route");
const { newKnowledgeKey } = await import("@/server/knowledge/keys");
const { sealCredential } = await import("@/lib/secrets");

const PLAN_ID = "test-plan-broker";
const ASANA = "asanaOAuth2Api";

async function wipe() {
  await prisma.installationCredential.deleteMany({});
  await prisma.installation.deleteMany({});
  await prisma.connector.deleteMany({});
  await prisma.product.deleteMany({});
  await prisma.user.deleteMany({});
  await prisma.plan.deleteMany({});
}

async function seed({ linked, expired = false }: { linked: boolean; expired?: boolean }) {
  await prisma.plan.upsert({
    where: { id: PLAN_ID },
    create: { id: PLAN_ID, name: "T", monthlyRuns: 1, storageBytes: BigInt(1), monthlyCredits: 0 },
    update: {},
  });
  const user = await prisma.user.create({
    data: { email: "b@example.test", name: "B", passwordHash: "x", initials: "B", planId: PLAN_ID },
  });
  const product = await prisma.product.create({
    data: {
      slug: `p-${Math.random().toString(36).slice(2, 8)}`,
      creatorId: user.id,
      title: "Digest",
      summary: "s",
      description: "d",
      needsFromYou: "n",
      kind: "WORKFLOW",
      category: "Reporting",
      status: "PUBLISHED",
      templateId: `tpl_${Math.random().toString(36).slice(2, 8)}`,
    },
  });
  const key = newKnowledgeKey();
  const installation = await prisma.installation.create({
    data: {
      userId: user.id,
      productId: product.id,
      pinnedVersion: product.version,
      storageBackend: "platform",
      status: "ACTIVE",
      knowledgeKeyHash: key.hash,
    },
  });
  const connector = await prisma.connector.create({
    data: {
      userId: user.id,
      credentialType: ASANA,
      displayName: "Nora (Asana)",
      initials: "AS",
      accountRef: "nora@acme.co",
      status: expired ? "EXPIRED" : "ACTIVE",
      secretJson: expired
        ? null
        : sealCredential({ access_token: "at-live", refresh_token: "rt-1" }),
      expiresAt: expired ? null : new Date(Date.now() + 30 * 60_000),
    },
  });
  if (linked) {
    await prisma.installationCredential.create({
      data: { installationId: installation.id, credentialType: ASANA, connectorId: connector.id },
    });
  }
  return key.key;
}

function ask(key: string | null, body: unknown) {
  return POST(
    new Request("https://app.example.test/api/connectors/token", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(key ? { authorization: `Bearer ${key}` } : {}),
      },
      body: JSON.stringify(body),
    }),
  );
}

beforeEach(async () => {
  await wipe();
});

afterAll(async () => {
  await wipe();
  await prisma.$disconnect();
});

describe("the connector token endpoint", () => {
  it("refuses a caller without an installation's key", async () => {
    await seed({ linked: true });
    expect((await ask(null, { credentialType: ASANA })).status).toBe(401);
    expect((await ask("kb_wrongwrongwrongwrongwrong", { credentialType: ASANA })).status).toBe(401);
  });

  it("does not know a tool that was never registered", async () => {
    const key = await seed({ linked: true });
    expect((await ask(key, { credentialType: "notATool" })).status).toBe(404);
  });

  it("refuses a tool the installation was not built with", async () => {
    const key = await seed({ linked: false });
    const response = await ask(key, { credentialType: ASANA });
    expect(response.status).toBe(404);
    expect(await response.text()).not.toContain("at-live");
  });

  it("answers with the current token to the installation it belongs to", async () => {
    const key = await seed({ linked: true });
    const response = await ask(key, { credentialType: ASANA });
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual({ access_token: "at-live", token_type: "bearer" });
  });

  it("serves Sheets from the Drive connection the installation was built with", async () => {
    await prisma.plan.upsert({
      where: { id: PLAN_ID },
      create: { id: PLAN_ID, name: "T", monthlyRuns: 1, storageBytes: BigInt(1), monthlyCredits: 0 },
      update: {},
    });
    const user = await prisma.user.create({
      data: { email: "s@example.test", name: "S", passwordHash: "x", initials: "S", planId: PLAN_ID },
    });
    const product = await prisma.product.create({
      data: {
        slug: `p-${Math.random().toString(36).slice(2, 8)}`,
        creatorId: user.id,
        title: "Sheets digest",
        summary: "s",
        description: "d",
        needsFromYou: "n",
        kind: "WORKFLOW",
        category: "Reporting",
        status: "PUBLISHED",
        templateId: `tpl_${Math.random().toString(36).slice(2, 8)}`,
      },
    });
    const key = newKnowledgeKey();
    const installation = await prisma.installation.create({
      data: {
        userId: user.id,
        productId: product.id,
        pinnedVersion: product.version,
        storageBackend: "platform",
        status: "ACTIVE",
        knowledgeKeyHash: key.hash,
      },
    });
    const drive = await prisma.connector.create({
      data: {
        userId: user.id,
        credentialType: "googleDriveOAuth2Api",
        displayName: "Google Drive",
        initials: "GD",
        accountRef: "s@example.test",
        status: "ACTIVE",
        secretJson: sealCredential({ access_token: "ya29.live", refresh_token: "1//rt" }),
        expiresAt: new Date(Date.now() + 30 * 60_000),
      },
    });
    await prisma.installationCredential.create({
      data: {
        installationId: installation.id,
        credentialType: "googleSheetsOAuth2Api",
        connectorId: drive.id,
      },
    });

    const response = await ask(key.key, { credentialType: "googleSheetsOAuth2Api" });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ access_token: "ya29.live", token_type: "bearer" });
  });

  it("tells the template to reconnect when the connection has ended", async () => {
    const key = await seed({ linked: true, expired: true });
    expect((await ask(key, { credentialType: ASANA })).status).toBe(409);
  });
});
