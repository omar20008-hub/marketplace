import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The platform's MCP endpoint. It must answer only to a key, show a person only the
 * servers they connected for their agents, route each call to the right server with
 * that server's own token, and never let that token out.
 */

const viewer = vi.hoisted(() => ({ current: null as { id: string; email: string } | null }));
vi.mock("@/lib/auth", () => ({
  requireUser: async () => {
    if (!viewer.current) throw new Error("no session in this test");
    return viewer.current;
  },
}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

const { prisma } = await import("@/lib/db");
const { POST, GET, DELETE } = await import("@/app/api/mcp/route");
const { gatewayRuntime } = await import("@/server/mcp-gateway");
const { newKnowledgeKey } = await import("@/server/knowledge/keys");
const { issueAgentKey, revokeAgentKeys } = await import("@/server/agent-keys");
const { sealCredential, openCredential } = await import("@/lib/secrets");
const { McpError } = await import("@/lib/mcp/client");
const { connectMcpServer } = await import("@/server/mcp-actions");
const { connectAccount } = await import("@/server/account-actions");
const { transport } = await import("@/lib/mcp/transport");

const PLAN_ID = "test-plan-mcp";
const MCP = "mcpServer";

async function wipe() {
  await prisma.agentKey.deleteMany({});
  await prisma.installationCredential.deleteMany({});
  await prisma.installation.deleteMany({});
  await prisma.connector.deleteMany({});
  await prisma.product.deleteMany({});
  await prisma.user.deleteMany({});
  await prisma.plan.deleteMany({});
}

async function makeUser(email: string) {
  await prisma.plan.upsert({
    where: { id: PLAN_ID },
    create: { id: PLAN_ID, name: "T", monthlyRuns: 1, storageBytes: BigInt(1), monthlyCredits: 0 },
    update: {},
  });
  return prisma.user.create({
    data: { email, name: email, passwordHash: "x", initials: "T", planId: PLAN_ID },
  });
}

async function installKey(userId: string) {
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
      templateId: `tpl_${Math.random().toString(36).slice(2, 8)}`,
    },
  });
  const key = newKnowledgeKey();
  await prisma.installation.create({
    data: {
      userId,
      productId: product.id,
      pinnedVersion: product.version,
      storageBackend: "platform",
      status: "ACTIVE",
      knowledgeKeyHash: key.hash,
    },
  });
  return key.key;
}

async function server(
  userId: string,
  name: string,
  options: { url?: string; bearer?: string; reusable?: boolean; status?: "ACTIVE" | "EXPIRED"; at?: number } = {},
) {
  const url = options.url ?? `https://${name.toLowerCase().replace(/\W/g, "-")}.example.com/mcp`;
  return prisma.connector.create({
    data: {
      userId,
      credentialType: MCP,
      displayName: name,
      initials: name.slice(0, 2).toUpperCase(),
      accountRef: url,
      status: options.status ?? "ACTIVE",
      reusable: options.reusable ?? true,
      secretJson: sealCredential({ url, ...(options.bearer ? { bearer: options.bearer } : {}) }),
      createdAt: new Date(options.at ?? Date.now()),
    },
  });
}

function rpc(key: string | null, body: unknown) {
  return POST(
    new Request("https://app.example.test/api/mcp", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(key ? { authorization: `Bearer ${key}` } : {}),
      },
      body: typeof body === "string" ? body : JSON.stringify(body),
    }),
  );
}

const listCall = { jsonrpc: "2.0", id: 1, method: "tools/list" };
const toolsOf = async (response: Response) =>
  ((await response.json()) as { result: { tools: { name: string; description: string }[] } }).result.tools;

beforeEach(async () => {
  await wipe();
  vi.restoreAllMocks();
  gatewayRuntime.listTools = vi.fn(async () => []) as unknown as typeof gatewayRuntime.listTools;
  gatewayRuntime.callTool = vi.fn(async () => ({ content: [] })) as unknown as typeof gatewayRuntime.callTool;
});

describe("who may ask", () => {
  it("refuses a request with no key, a made-up key, and a revoked agent key", async () => {
    expect((await rpc(null, listCall)).status).toBe(401);
    expect((await rpc("kb_" + "x".repeat(40), listCall)).status).toBe(401);
    expect((await rpc("ak_" + "y".repeat(40), listCall)).status).toBe(401);

    const user = await makeUser("a@example.test");
    const agentKey = await issueAgentKey(user.id);
    expect((await rpc(agentKey, listCall)).status).toBe(200);
    await revokeAgentKeys(user.id);
    expect((await rpc(agentKey, listCall)).status).toBe(401);
  });

  it("offers no GET or DELETE, since it keeps no stream and no session", async () => {
    expect((await GET()).status).toBe(405);
    expect((await DELETE()).status).toBe(405);
  });
});

describe("the protocol", () => {
  it("answers initialize with its own name and the protocol version the caller asked for", async () => {
    const user = await makeUser("a@example.test");
    const key = await installKey(user.id);

    const asked = await (
      await rpc(key, { jsonrpc: "2.0", id: 7, method: "initialize", params: { protocolVersion: "2025-03-26" } })
    ).json();
    expect(asked.id).toBe(7);
    expect(asked.result.protocolVersion).toBe("2025-03-26");
    expect(asked.result.serverInfo.name).toBe("builder-platform");
    expect(asked.result.capabilities.tools).toBeDefined();

    const unknown = await (
      await rpc(key, { jsonrpc: "2.0", id: 8, method: "initialize", params: { protocolVersion: "1999-01-01" } })
    ).json();
    expect(unknown.result.protocolVersion).toBe("2025-06-18");
  });

  it("gives a notification no answer, and answers ping", async () => {
    const user = await makeUser("a@example.test");
    const key = await installKey(user.id);
    const note = await rpc(key, { jsonrpc: "2.0", method: "notifications/initialized" });
    expect(note.status).toBe(202);
    expect(await note.text()).toBe("");
    expect((await (await rpc(key, { jsonrpc: "2.0", id: 2, method: "ping" })).json()).result).toEqual({});
  });

  it("refuses a body that is not one JSON-RPC request, and an unknown method", async () => {
    const user = await makeUser("a@example.test");
    const key = await installKey(user.id);
    expect((await rpc(key, "{not json")).status).toBe(400);
    expect((await rpc(key, [listCall])).status).toBe(400);
    expect((await rpc(key, { id: 1, method: "tools/list" })).status).toBe(400);
    const unknown = await (await rpc(key, { jsonrpc: "2.0", id: 3, method: "resources/list" })).json();
    expect(unknown.error.code).toBe(-32601);
  });
});

describe("listing tools", () => {
  it("shows every tool of the person's servers, named <server>__<tool>, labelled with the server", async () => {
    const user = await makeUser("a@example.test");
    const key = await installKey(user.id);
    await server(user.id, "n8n", { at: 1_000 });
    await server(user.id, "Notion", { at: 2_000 });
    gatewayRuntime.listTools = vi.fn(async (s: { url: string }) =>
      s.url.includes("notion")
        ? [{ name: "search", description: "Find pages" }]
        : [{ name: "run_workflow" }, { name: "search" }],
    ) as unknown as typeof gatewayRuntime.listTools;

    const tools = await toolsOf(await rpc(key, listCall));
    expect(tools.map((t) => t.name).sort()).toEqual(["n8n__run_workflow", "n8n__search", "notion__search"]);
    expect(tools.find((t) => t.name === "notion__search")!.description).toBe("[Notion] Find pages");
  });

  it("shows only active servers that are marked for agents and workflows, and only the person's own", async () => {
    const user = await makeUser("a@example.test");
    const other = await makeUser("b@example.test");
    const key = await installKey(user.id);
    await server(user.id, "Shown");
    await server(user.id, "Private", { reusable: false });
    await server(user.id, "Lapsed", { status: "EXPIRED" });
    await server(other.id, "Theirs");
    gatewayRuntime.listTools = vi.fn(async () => [{ name: "t" }]) as unknown as typeof gatewayRuntime.listTools;

    expect((await toolsOf(await rpc(key, listCall))).map((t) => t.name)).toEqual(["shown__t"]);
  });

  it("serves the same tools to a person's agent key as to an installation key", async () => {
    const user = await makeUser("a@example.test");
    await server(user.id, "n8n");
    gatewayRuntime.listTools = vi.fn(async () => [{ name: "t" }]) as unknown as typeof gatewayRuntime.listTools;
    const viaAgent = await toolsOf(await rpc(await issueAgentKey(user.id), listCall));
    const viaInstall = await toolsOf(await rpc(await installKey(user.id), listCall));
    expect(viaAgent.map((t) => t.name)).toEqual(["n8n__t"]);
    expect(viaInstall).toEqual(viaAgent);
  });

  it("still lists the others when one server is down", async () => {
    const user = await makeUser("a@example.test");
    const key = await installKey(user.id);
    await server(user.id, "Up", { at: 1_000 });
    await server(user.id, "Down", { at: 2_000 });
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    gatewayRuntime.listTools = vi.fn(async (s: { url: string }) => {
      if (s.url.includes("down")) throw new McpError("The server could not be reached.", "unreachable");
      return [{ name: "t" }];
    }) as unknown as typeof gatewayRuntime.listTools;

    expect((await toolsOf(await rpc(key, listCall))).map((t) => t.name)).toEqual(["up__t"]);
  });

  it("gives two servers with the same name different prefixes, the older keeping the plain one", async () => {
    const user = await makeUser("a@example.test");
    const key = await installKey(user.id);
    await server(user.id, "n8n", { url: "https://one.example.com/mcp", at: 1_000 });
    await server(user.id, "n8n", { url: "https://two.example.com/mcp", at: 2_000 });
    gatewayRuntime.listTools = vi.fn(async (s: { url: string }) => [
      { name: s.url.includes("one") ? "from_one" : "from_two" },
    ]) as unknown as typeof gatewayRuntime.listTools;

    const names = (await toolsOf(await rpc(key, listCall))).map((t) => t.name);
    // The older server keeps the plain prefix, the newer one is numbered.
    expect(names).toHaveLength(2);
    expect(names).toContain("n8n__from_one");
    expect(names).toContain("n8n_2__from_two");
  });
});

describe("calling a tool", () => {
  const call = (name: unknown, args?: unknown) => ({
    jsonrpc: "2.0",
    id: 9,
    method: "tools/call",
    params: { name, ...(args === undefined ? {} : { arguments: args }) },
  });

  it("routes the call to its own server, under the tool's real name, with that server's token", async () => {
    const user = await makeUser("a@example.test");
    const key = await installKey(user.id);
    await server(user.id, "n8n", { bearer: "n8n-token", at: 1_000 });
    await server(user.id, "Notion", { bearer: "notion-token", at: 2_000 });
    const callTool = vi.fn(async () => ({ content: [{ type: "text", text: "ok" }] }));
    gatewayRuntime.callTool = callTool as unknown as typeof gatewayRuntime.callTool;

    const response = await (await rpc(key, call("notion__search", { q: "plans" }))).json();

    expect(response.result.content).toEqual([{ type: "text", text: "ok" }]);
    expect(callTool).toHaveBeenCalledTimes(1);
    expect(callTool).toHaveBeenCalledWith(
      expect.objectContaining({ bearer: "notion-token", url: "https://notion.example.com/mcp" }),
      "search",
      { q: "plans" },
    );
  });

  it("never puts a server's token in anything it returns", async () => {
    const user = await makeUser("a@example.test");
    const key = await installKey(user.id);
    await server(user.id, "n8n", { bearer: "super-secret-token" });
    gatewayRuntime.listTools = vi.fn(async () => [{ name: "t" }]) as unknown as typeof gatewayRuntime.listTools;

    expect(await (await rpc(key, listCall)).text()).not.toContain("super-secret-token");
    expect(await (await rpc(key, call("n8n__t", {}))).text()).not.toContain("super-secret-token");
  });

  it("will not call a tool of a server that is private, lapsed, another person's, or unknown", async () => {
    const user = await makeUser("a@example.test");
    const other = await makeUser("b@example.test");
    const key = await installKey(user.id);
    await server(user.id, "Private", { reusable: false });
    await server(user.id, "Lapsed", { status: "EXPIRED" });
    await server(other.id, "Theirs");
    const callTool = vi.fn();
    gatewayRuntime.callTool = callTool as unknown as typeof gatewayRuntime.callTool;

    for (const name of ["private__t", "lapsed__t", "theirs__t", "nobody__t", "no-delimiter", 42]) {
      const answer = await (await rpc(key, call(name, {}))).json();
      expect(answer.error.code, String(name)).toBe(-32602);
    }
    expect(callTool).not.toHaveBeenCalled();
  });

  it("refuses arguments that are not an object", async () => {
    const user = await makeUser("a@example.test");
    const key = await installKey(user.id);
    await server(user.id, "n8n");
    const answer = await (await rpc(key, call("n8n__t", ["not", "an", "object"]))).json();
    expect(answer.error.code).toBe(-32602);
  });

  it("passes a tool's own failure through as the result, and reports a server failure as an error", async () => {
    const user = await makeUser("a@example.test");
    const key = await installKey(user.id);
    await server(user.id, "n8n");

    gatewayRuntime.callTool = vi.fn(async () => ({
      isError: true,
      content: [{ type: "text", text: "no such workflow" }],
    })) as unknown as typeof gatewayRuntime.callTool;
    const failed = await (await rpc(key, call("n8n__t", {}))).json();
    expect(failed.result.isError).toBe(true);

    gatewayRuntime.callTool = vi.fn(async () => {
      throw new McpError("The server took too long to answer.", "timeout");
    }) as unknown as typeof gatewayRuntime.callTool;
    const timedOut = await (await rpc(key, call("n8n__t", {}))).json();
    expect(timedOut.error.message).toContain("n8n");
    expect(timedOut.error.message).toContain("too long");
  });

  it("marks a server for reconnecting when it refuses its token, and stops offering it", async () => {
    const user = await makeUser("a@example.test");
    const key = await installKey(user.id);
    const connector = await server(user.id, "n8n", { bearer: "revoked" });
    gatewayRuntime.callTool = vi.fn(async () => {
      throw new McpError("The server did not accept the access token.", "unauthorized");
    }) as unknown as typeof gatewayRuntime.callTool;

    const answer = await (await rpc(key, call("n8n__t", {}))).json();
    expect(answer.error.message).toContain("Reconnect it from Connectors");
    expect((await prisma.connector.findUniqueOrThrow({ where: { id: connector.id } })).status).toBe("EXPIRED");

    gatewayRuntime.listTools = vi.fn(async () => [{ name: "t" }]) as unknown as typeof gatewayRuntime.listTools;
    expect(await toolsOf(await rpc(key, listCall))).toEqual([]);
  });
});

describe("keeping the gateway up", () => {
  const call = (name: unknown, args?: unknown) => ({
    jsonrpc: "2.0",
    id: 9,
    method: "tools/call",
    params: { name, ...(args === undefined ? {} : { arguments: args }) },
  });

  it("skips a server whose stored secret cannot be read, and still serves the others", async () => {
    const user = await makeUser("a@example.test");
    const key = await installKey(user.id);
    await server(user.id, "Good", { at: 1_000 });
    await prisma.connector.create({
      data: {
        userId: user.id, credentialType: MCP, displayName: "Broken", initials: "BR",
        accountRef: "https://broken.example.com/mcp", status: "ACTIVE", reusable: true,
        secretJson: "v1.not.a.real.secret", createdAt: new Date(2_000),
      },
    });
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    gatewayRuntime.listTools = vi.fn(async () => [{ name: "t" }]) as unknown as typeof gatewayRuntime.listTools;

    expect((await toolsOf(await rpc(key, listCall))).map((t) => t.name)).toEqual(["good__t"]);
  });

  it("does not ask a server that just failed again straight away", async () => {
    const user = await makeUser("a@example.test");
    const key = await installKey(user.id);
    await server(user.id, "Flaky");
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const listTools = vi.fn(async () => {
      throw new McpError("The server could not be reached.", "unreachable");
    });
    gatewayRuntime.listTools = listTools as unknown as typeof gatewayRuntime.listTools;

    await rpc(key, listCall);
    await rpc(key, listCall);
    await rpc(key, listCall);
    expect(listTools).toHaveBeenCalledTimes(1);
  });

  it("does not switch a server off for a 403, only for a 401", async () => {
    const user = await makeUser("a@example.test");
    const key = await installKey(user.id);
    const connector = await server(user.id, "n8n");
    gatewayRuntime.callTool = vi.fn(async () => {
      throw new McpError("The server refused access with that token.", "forbidden");
    }) as unknown as typeof gatewayRuntime.callTool;

    const answer = await (await rpc(key, call("n8n__t", {}))).json();
    expect(answer.error.message).toContain("refused access");
    expect((await prisma.connector.findUniqueOrThrow({ where: { id: connector.id } })).status).toBe("ACTIVE");
  });

  it("does not rename a server's tools when an older server with the same name lapses", async () => {
    const user = await makeUser("a@example.test");
    const key = await installKey(user.id);
    const older = await server(user.id, "n8n", { url: "https://one.example.com/mcp", at: 1_000 });
    await server(user.id, "n8n", { url: "https://two.example.com/mcp", at: 2_000 });
    gatewayRuntime.listTools = vi.fn(async () => [{ name: "t" }]) as unknown as typeof gatewayRuntime.listTools;

    expect((await toolsOf(await rpc(key, listCall))).map((t) => t.name).sort()).toEqual(["n8n_2__t", "n8n__t"]);
    await prisma.connector.update({ where: { id: older.id }, data: { status: "EXPIRED" } });
    // The newer server is still n8n_2: it did not quietly become n8n.
    expect((await toolsOf(await rpc(key, listCall))).map((t) => t.name)).toEqual(["n8n_2__t"]);
  });

  it("accepts a response sent by the client with a 202, as the transport says", async () => {
    const user = await makeUser("a@example.test");
    const key = await installKey(user.id);
    expect((await rpc(key, { jsonrpc: "2.0", id: 5, result: {} })).status).toBe(202);
  });

  it("refuses a request body over the limit", async () => {
    const user = await makeUser("a@example.test");
    const key = await installKey(user.id);
    const big = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping", params: { pad: "x".repeat(1024 * 1024) } });
    expect((await rpc(key, big)).status).toBe(413);
  });

  it("limits how many requests one person can have running at once", async () => {
    const user = await makeUser("a@example.test");
    const key = await installKey(user.id);
    await server(user.id, "n8n");
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    gatewayRuntime.callTool = vi.fn(async () => {
      await gate;
      return { content: [] };
    }) as unknown as typeof gatewayRuntime.callTool;

    const running = Array.from({ length: 8 }, () => rpc(key, call("n8n__t", {})));
    await new Promise((resolve) => setTimeout(resolve, 300));
    const ninth = await rpc(key, call("n8n__t", {}));
    expect(ninth.status).toBe(429);

    release();
    for (const response of await Promise.all(running)) expect(response.status).toBe(200);
    // And once they are done, the person can ask again.
    expect((await rpc(key, call("n8n__t", {}))).status).toBe(200);
  });
});

describe("connecting a server", () => {
  const form = (fields: Record<string, string>) => {
    const data = new FormData();
    for (const [key, value] of Object.entries(fields)) data.set(key, value);
    return data;
  };

  async function asUser(email: string) {
    const user = await makeUser(email);
    viewer.current = { id: user.id, email };
    return user;
  }

  const realSend = transport.send;
  afterEach(() => {
    transport.send = realSend;
  });

  /** A server that answers the handshake and lists two tools, or answers every request with `status`. */
  function stubNetwork(status = 200) {
    transport.send = (async (req: { method: string; body?: string }) => {
      if (status !== 200) return { status, headers: {}, text: "no" };
      const body = req.body ? JSON.parse(req.body) : undefined;
      if (req.method === "DELETE") return { status: 204, headers: {}, text: "" };
      if (body?.id === undefined) return { status: 202, headers: {}, text: "" };
      const result =
        body.method === "initialize"
          ? { protocolVersion: "2025-06-18", capabilities: {} }
          : { tools: [{ name: "a" }, { name: "b" }] };
      return {
        status: 200,
        headers: { "content-type": "application/json" },
        text: JSON.stringify({ jsonrpc: "2.0", id: body.id, result }),
      };
    }) as unknown as typeof transport.send;
  }

  it("checks the server, then keeps its address and token sealed", async () => {
    const user = await asUser("a@example.test");
    stubNetwork();

    const state = await connectMcpServer(
      {},
      form({ name: "n8n", url: "https://93.184.216.34/mcp", token: "tok-123", reusable: "all" }),
    );

    expect(state).toEqual({ done: true, message: "Connected. 2 tools found." });
    const saved = await prisma.connector.findFirstOrThrow({ where: { userId: user.id, credentialType: MCP } });
    expect(saved.displayName).toBe("n8n");
    expect(saved.accountRef).toBe("https://93.184.216.34/mcp");
    expect(saved.reusable).toBe(true);
    expect(saved.secretJson).not.toContain("tok-123");
    expect(openCredential(saved.secretJson)).toEqual({ url: "https://93.184.216.34/mcp", bearer: "tok-123" });
  });

  it("refuses an unsafe address and a server that does not answer, saving nothing", async () => {
    const user = await asUser("a@example.test");

    expect((await connectMcpServer({}, form({ name: "x", url: "http://93.184.216.34/mcp" }))).error).toMatch(/https/);
    expect((await connectMcpServer({}, form({ name: "x", url: "https://10.0.0.1/mcp" }))).error).toMatch(/private network/);
    expect((await connectMcpServer({}, form({ name: "x", url: "https://93.184.216.34/mcp?token=1" }))).error).toMatch(/token field/);
    expect((await connectMcpServer({}, form({ name: "", url: "https://93.184.216.34/mcp" }))).error).toMatch(/name/);

    stubNetwork(401);
    expect((await connectMcpServer({}, form({ name: "x", url: "https://93.184.216.34/mcp", token: "bad" }))).error).toMatch(
      /did not accept the access token/,
    );
    stubNetwork(403);
    expect((await connectMcpServer({}, form({ name: "x", url: "https://93.184.216.34/mcp", token: "weak" }))).error).toMatch(
      /refused access/,
    );

    expect(await prisma.connector.count({ where: { userId: user.id } })).toBe(0);
  });

  it("hands back what was typed on an error, so the form keeps it, but never the token", async () => {
    await asUser("a@example.test");
    const state = await connectMcpServer(
      {},
      form({ name: "My n8n", url: "https://10.0.0.1/mcp", token: "do-not-echo-me" }),
    );
    expect(state.error).toBeDefined();
    expect(state.values).toEqual({ name: "My n8n", url: "https://10.0.0.1/mcp" });
    expect(JSON.stringify(state)).not.toContain("do-not-echo-me");
  });

  it("limits how many servers one person can connect", async () => {
    const user = await asUser("a@example.test");
    for (let i = 0; i < 10; i++) await server(user.id, `s${i}`);
    const state = await connectMcpServer({}, form({ name: "eleventh", url: "https://93.184.216.34/mcp" }));
    expect(state.error).toMatch(/at most 10/);
  });

  it("cannot be sidestepped by the generic connect action, which would skip those checks", async () => {
    const user = await asUser("a@example.test");
    const state = await connectAccount(
      {},
      form({ credentialType: MCP, "field.url": "https://169.254.169.254/x", "field.accountRef": "https://169.254.169.254/x" }),
    );
    expect(state.error).toMatch(/own form/);
    expect(await prisma.connector.count({ where: { userId: user.id } })).toBe(0);
  });
});
