import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The generic sign-in into an outside tool, end to end against Postgres with the
 * tool's own endpoints stubbed.
 *
 * The callback is the part that matters: it turns a request arriving with a
 * code into a stored connection, so every way of arriving without the state this
 * app issued to this user has to end in a refusal and no row.
 */

const viewer = vi.hoisted(() => ({ current: null as { id: string } | null }));
vi.mock("@/lib/auth", () => ({
  requireUser: async () => {
    if (!viewer.current) throw new Error("no session in this test");
    return viewer.current;
  },
}));

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
const { GET: start } = await import("@/app/api/connectors/[provider]/start/route");
const { GET: callback } = await import("@/app/api/connectors/[provider]/callback/route");
const { decryptSecret } = await import("@/lib/secrets");
const { TOOL_CONNECT_ERRORS } = await import("@/lib/connectors/messages");

const APP = "https://app.example.test";
const PLAN_ID = "test-plan-connectors";
const ASANA_TYPE = "asanaOAuth2Api";

type Answer = { status?: number; body: unknown };
const tokenAnswers: Answer[] = [];
const identityAnswers: Answer[] = [];

function jsonResponse({ status = 200, body }: Answer) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function stubAsana() {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      if (url.startsWith("https://app.asana.com/-/oauth_token")) {
        return jsonResponse(tokenAnswers.shift() ?? { status: 400, body: { error: "invalid_grant" } });
      }
      if (url.startsWith("https://app.asana.com/api/1.0/users/me")) {
        return jsonResponse(identityAnswers.shift() ?? { status: 401, body: {} });
      }
      throw new Error(`unexpected fetch to ${url}`);
    }),
  );
}

async function wipe() {
  await prisma.installationCredential.deleteMany({});
  await prisma.installation.deleteMany({});
  await prisma.connector.deleteMany({});
  await prisma.user.deleteMany({});
  await prisma.plan.deleteMany({});
}

async function seedUser(email = "u@example.test") {
  await prisma.plan.upsert({
    where: { id: PLAN_ID },
    create: { id: PLAN_ID, name: "T", monthlyRuns: 1, storageBytes: BigInt(1), monthlyCredits: 0 },
    update: {},
  });
  const user = await prisma.user.create({
    data: { email, name: "U", passwordHash: "x", initials: "U", planId: PLAN_ID },
  });
  viewer.current = user;
  return user;
}

function req(path: string, cookie?: string) {
  return new Request(`${APP}${path}`, cookie ? { headers: { cookie } } : undefined);
}

const provider = (p: string) => ({ params: Promise.resolve({ provider: p }) });

/** Runs the start route and returns the state the tool would echo back, plus the cookie. */
async function beginAsana(returnTo = "/accounts") {
  const response = await start(req(`/api/connectors/asana/start?returnTo=${encodeURIComponent(returnTo)}`), provider("asana"));
  const location = new URL(response.headers.get("location")!);
  const cookie = response.cookies.get("c_oauth_asana")!;
  return {
    response,
    state: location.searchParams.get("state")!,
    cookieHeader: `c_oauth_asana=${cookie.value}`,
    location,
  };
}

function finishAsana(params: Record<string, string>, cookieHeader: string) {
  const query = new URLSearchParams(params).toString();
  return callback(req(`/api/connectors/asana/callback?${query}`, cookieHeader), provider("asana"));
}

beforeEach(async () => {
  asanaSettings.clientId = "asana-client";
  asanaSettings.clientSecret = "asana-secret";
  tokenAnswers.length = 0;
  identityAnswers.length = 0;
  stubAsana();
  await wipe();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

afterAll(async () => {
  await wipe();
  await prisma.$disconnect();
});

describe("starting a sign-in", () => {
  it("does not know a tool that was never registered", async () => {
    await seedUser();
    const response = await start(req("/api/connectors/nope/start"), provider("nope"));
    expect(response.status).toBe(404);
  });

  it("sends the person to the tool with a state and the callback for this app", async () => {
    await seedUser();
    const { location, cookieHeader } = await beginAsana();

    expect(location.origin + location.pathname).toBe("https://app.asana.com/-/oauth_authorize");
    expect(location.searchParams.get("client_id")).toBe("asana-client");
    expect(location.searchParams.get("redirect_uri")).toBe(`${APP}/api/connectors/asana/callback`);
    expect(location.searchParams.get("response_type")).toBe("code");
    expect(location.searchParams.get("state")).toBeTruthy();
    expect(cookieHeader).toContain("c_oauth_asana=");
  });

  it("says which settings are missing instead of sending the person to a broken page", async () => {
    await seedUser();
    asanaSettings.clientSecret = "";
    const response = await start(req("/api/connectors/asana/start?returnTo=/accounts"), provider("asana"));
    expect(response.headers.get("location")).toContain("connect_error=tool_not_configured");
  });
});

describe("finishing a sign-in", () => {
  it("stores the connection encrypted, under the tool's type and the person's account", async () => {
    const user = await seedUser();
    const { state, cookieHeader } = await beginAsana("/workspace");
    tokenAnswers.push({ body: { access_token: "at-1", refresh_token: "rt-1", expires_in: 3600 } });
    identityAnswers.push({ body: { data: { gid: "9", email: "Nora@Acme.co", name: "Nora" } } });

    const response = await finishAsana({ state, code: "code-1" }, cookieHeader);

    expect(response.headers.get("location")).toBe(`${APP}/workspace?connected=${ASANA_TYPE}`);
    const row = await prisma.connector.findFirstOrThrow({ where: { userId: user.id } });
    expect(row.credentialType).toBe(ASANA_TYPE);
    expect(row.accountRef).toBe("nora@acme.co");
    expect(row.displayName).toBe("Nora (Asana)");
    expect(row.status).toBe("ACTIVE");
    expect(row.secretJson).not.toContain("at-1");
    expect(JSON.parse(decryptSecret(row.secretJson!))).toEqual({
      access_token: "at-1",
      refresh_token: "rt-1",
    });
  });

  it("keeps the refresh token it already had when the tool does not send one again", async () => {
    const user = await seedUser();
    for (const refresh of ["rt-first", undefined]) {
      const { state, cookieHeader } = await beginAsana();
      tokenAnswers.push({
        body: refresh ? { access_token: "at", refresh_token: refresh } : { access_token: "at" },
      });
      identityAnswers.push({ body: { data: { gid: "9", email: "nora@acme.co" } } });
      await finishAsana({ state, code: "c" }, cookieHeader);
    }
    const rows = await prisma.connector.findMany({ where: { userId: user.id } });
    expect(rows).toHaveLength(1);
    expect(JSON.parse(decryptSecret(rows[0].secretJson!)).refresh_token).toBe("rt-first");
  });

  it("refuses a state that was issued to another person", async () => {
    await seedUser("a@example.test");
    const { state, cookieHeader } = await beginAsana();
    await seedUser("b@example.test");
    const response = await finishAsana({ state, code: "c" }, cookieHeader);
    expect(response.headers.get("location")).toContain("connect_error=tool_state");
    expect(await prisma.connector.count()).toBe(0);
  });

  it("refuses a return with no state, or a state that does not match its cookie", async () => {
    await seedUser();
    const { cookieHeader } = await beginAsana();
    const response = await finishAsana({ state: "forged", code: "c" }, cookieHeader);
    expect(response.headers.get("location")).toContain("connect_error=tool_state");
    expect(await prisma.connector.count()).toBe(0);
  });

  it("reports a refusal at the tool as a refusal, with nothing stored", async () => {
    await seedUser();
    const { state, cookieHeader } = await beginAsana();
    const response = await finishAsana({ state, error: "access_denied" }, cookieHeader);
    expect(response.headers.get("location")).toContain("connect_error=tool_denied");
    expect(await prisma.connector.count()).toBe(0);
  });

  it("stores nothing when the tool will not issue a token", async () => {
    await seedUser();
    const { state, cookieHeader } = await beginAsana();
    tokenAnswers.push({ status: 400, body: { error: "invalid_grant" } });
    const response = await finishAsana({ state, code: "stale" }, cookieHeader);
    expect(response.headers.get("location")).toContain("connect_error=tool_token");
    expect(await prisma.connector.count()).toBe(0);
  });

  it("stores nothing when the tool does not say who the person is", async () => {
    await seedUser();
    const { state, cookieHeader } = await beginAsana();
    tokenAnswers.push({ body: { access_token: "at" } });
    identityAnswers.push({ body: { data: {} } });
    const response = await finishAsana({ state, code: "c" }, cookieHeader);
    expect(response.headers.get("location")).toContain("connect_error=tool_identity");
    expect(await prisma.connector.count()).toBe(0);
  });

  it("has a plain message for every code the callback can send", () => {
    for (const code of ["tool_not_configured", "tool_state", "tool_denied", "tool_token", "tool_identity", "tool_failed"]) {
      expect(TOOL_CONNECT_ERRORS[code]).toBeTruthy();
    }
  });
});
