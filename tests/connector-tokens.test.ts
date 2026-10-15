import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Renewing a connection made through the generic sign-in. The rule that matters:
 * only the tool refusing the grant ends a connection; anything else leaves it
 * ACTIVE for the next attempt.
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
const { getConnectorAccessToken, ConnectorAuthError } = await import("@/server/connector-tokens");
const { sealCredential, decryptSecret } = await import("@/lib/secrets");

const PLAN_ID = "test-plan-connector-tokens";
const ASANA_TYPE = "asanaOAuth2Api";

let fetchAnswers: { status: number; body: unknown }[] = [];
let connectorId = "";

function stubFetch() {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      if (!url.startsWith("https://app.asana.com/-/oauth_token")) throw new Error(`unexpected ${url}`);
      const next = fetchAnswers.shift() ?? { status: 500, body: {} };
      return new Response(JSON.stringify(next.body), {
        status: next.status,
        headers: { "content-type": "application/json" },
      });
    }),
  );
}

async function wipe() {
  await prisma.connector.deleteMany({});
  await prisma.user.deleteMany({});
  await prisma.plan.deleteMany({});
}

async function seedConnector(over: { expiresInMs: number; refreshToken?: string | null; accessToken?: string }) {
  await prisma.plan.upsert({
    where: { id: PLAN_ID },
    create: { id: PLAN_ID, name: "T", monthlyRuns: 1, storageBytes: BigInt(1), monthlyCredits: 0 },
    update: {},
  });
  const user = await prisma.user.create({
    data: { email: "t@example.test", name: "T", passwordHash: "x", initials: "T", planId: PLAN_ID },
  });
  const secret: Record<string, string> = { access_token: over.accessToken ?? "at-old" };
  if (over.refreshToken !== null) secret.refresh_token = over.refreshToken ?? "rt-1";
  const connector = await prisma.connector.create({
    data: {
      userId: user.id,
      credentialType: ASANA_TYPE,
      displayName: "Nora (Asana)",
      initials: "AS",
      accountRef: "nora@acme.co",
      status: "ACTIVE",
      secretJson: sealCredential(secret),
      expiresAt: new Date(Date.now() + over.expiresInMs),
    },
  });
  connectorId = connector.id;
}

beforeEach(async () => {
  fetchAnswers = [];
  stubFetch();
  await wipe();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

afterAll(async () => {
  await wipe();
  await prisma.$disconnect();
});

describe("getting a token for a generic connection", () => {
  it("uses the stored token while it is fresh, without calling the tool", async () => {
    await seedConnector({ expiresInMs: 30 * 60_000, accessToken: "at-fresh" });
    expect(await getConnectorAccessToken(connectorId)).toBe("at-fresh");
    expect(vi.mocked(fetch)).not.toHaveBeenCalled();
  });

  it("renews a lapsed token and stores the new one, keeping the refresh token", async () => {
    await seedConnector({ expiresInMs: -1000 });
    fetchAnswers.push({ status: 200, body: { access_token: "at-new", expires_in: 3600 } });

    expect(await getConnectorAccessToken(connectorId)).toBe("at-new");

    const row = await prisma.connector.findUniqueOrThrow({ where: { id: connectorId } });
    expect(row.status).toBe("ACTIVE");
    expect(row.expiresAt!.getTime()).toBeGreaterThan(Date.now() + 3000 * 1000);
    expect(JSON.parse(decryptSecret(row.secretJson!))).toEqual({
      access_token: "at-new",
      refresh_token: "rt-1",
    });
  });

  it("takes a rotated refresh token when the tool sends one", async () => {
    await seedConnector({ expiresInMs: -1000 });
    fetchAnswers.push({ status: 200, body: { access_token: "at-new", refresh_token: "rt-2", expires_in: 3600 } });
    await getConnectorAccessToken(connectorId);
    const row = await prisma.connector.findUniqueOrThrow({ where: { id: connectorId } });
    expect(JSON.parse(decryptSecret(row.secretJson!)).refresh_token).toBe("rt-2");
  });

  it("ends the connection when the tool refuses the grant", async () => {
    await seedConnector({ expiresInMs: -1000 });
    fetchAnswers.push({ status: 400, body: { error: "invalid_grant" } });

    const error = await getConnectorAccessToken(connectorId).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(ConnectorAuthError);
    expect((error as InstanceType<typeof ConnectorAuthError>).permanent).toBe(true);
    const row = await prisma.connector.findUniqueOrThrow({ where: { id: connectorId } });
    expect(row.status).toBe("EXPIRED");
    expect(row.secretJson).toBeNull();
  });

  it("keeps the connection when the tool fails for a reason that says nothing about the account", async () => {
    await seedConnector({ expiresInMs: -1000 });
    fetchAnswers.push({ status: 503, body: {} });

    const error = await getConnectorAccessToken(connectorId).catch((e: unknown) => e);

    expect((error as InstanceType<typeof ConnectorAuthError>).permanent).toBe(false);
    const row = await prisma.connector.findUniqueOrThrow({ where: { id: connectorId } });
    expect(row.status).toBe("ACTIVE");
    expect(row.secretJson).not.toBeNull();
  });

  it("ends a connection that has no refresh token once its access token lapses", async () => {
    await seedConnector({ expiresInMs: -1000, refreshToken: null });
    await expect(getConnectorAccessToken(connectorId)).rejects.toThrow();
    const row = await prisma.connector.findUniqueOrThrow({ where: { id: connectorId } });
    expect(row.status).toBe("EXPIRED");
    expect(vi.mocked(fetch)).not.toHaveBeenCalled();
  });
});
