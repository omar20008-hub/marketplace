import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The Orchestrator reaching a person's MCP servers, with the database and the gateway
 * behind it. Only the network to the servers is replaced. The last block runs a whole
 * conversation: a request, the proposal, the person's "yes", and the call.
 */

const { prisma } = await import("@/lib/db");
const { gatewayRuntime } = await import("@/server/mcp-gateway");
const { sealCredential } = await import("@/lib/secrets");
const { McpError } = await import("@/lib/mcp/client");
const { createConnectorHandlers, formatToolResult, summarizeFields } = await import(
  "@/server/orchestrator/runtimes/connectors"
);
const { answerOnPlatform } = await import("@/server/orchestrator/assistant");
const { CONNECTOR_CALL_TOOL, CONNECTOR_FIND_TOOL } = await import("@/server/orchestrator/engine");

import type { ChatModel, ModelReply, ModelRequest } from "@/server/orchestrator/model";

const PLAN_ID = "test-plan-orch-mcp";

async function wipe() {
  await prisma.orchestratorPendingAction.deleteMany({});
  await prisma.message.deleteMany({});
  await prisma.thread.deleteMany({});
  await prisma.installation.deleteMany({});
  await prisma.connector.deleteMany({});
  await prisma.product.deleteMany({});
  await prisma.user.deleteMany({});
  await prisma.plan.deleteMany({});
}

async function makeUser(email: string) {
  await prisma.plan.upsert({
    where: { id: PLAN_ID },
    create: { id: PLAN_ID, name: "T", monthlyRuns: 100, storageBytes: BigInt(1_000_000), monthlyCredits: 0 },
    update: {},
  });
  return prisma.user.create({ data: { email, name: email, passwordHash: "x", initials: "T", planId: PLAN_ID } });
}

async function server(userId: string, name: string, options: { reusable?: boolean; at?: number } = {}) {
  const url = `https://${name.toLowerCase().replace(/\W/g, "-")}.example.com/mcp`;
  return prisma.connector.create({
    data: {
      userId,
      credentialType: "mcpServer",
      displayName: name,
      initials: name.slice(0, 2).toUpperCase(),
      accountRef: url,
      status: "ACTIVE",
      reusable: options.reusable ?? true,
      secretJson: sealCredential({ url, bearer: `${name}-token` }),
      createdAt: new Date(options.at ?? Date.now()),
    },
  });
}

const HUBSPOT_TOOLS = [
  {
    name: "list_contacts",
    description: "List the contacts in the CRM",
    annotations: { readOnlyHint: true },
    inputSchema: { type: "object", properties: { limit: { type: "number", description: "How many" } } },
  },
  {
    name: "create_contact",
    description: "Create a contact in the CRM",
    inputSchema: {
      type: "object",
      properties: {
        email: { type: "string", description: "Contact's email" },
        stage: { type: "string", enum: ["lead", "customer"] },
      },
      required: ["email"],
    },
  },
];

function stubServers() {
  gatewayRuntime.listTools = vi.fn(async (s: { url: string }) =>
    s.url.includes("hubspot")
      ? HUBSPOT_TOOLS
      : [{ name: "search_pages", description: "Search Notion pages", annotations: { readOnlyHint: true } }],
  ) as unknown as typeof gatewayRuntime.listTools;
  gatewayRuntime.callTool = vi.fn(async () => ({
    content: [{ type: "text", text: "contact created" }],
  })) as unknown as typeof gatewayRuntime.callTool;
}

beforeEach(async () => {
  await wipe();
  vi.restoreAllMocks();
  stubServers();
});

describe("formatToolResult and summarizeFields", () => {
  it("turns text parts into one string and names what it cannot carry", () => {
    const out = JSON.parse(
      formatToolResult({
        content: [
          { type: "text", text: "line one" },
          { type: "image", data: "AAAA", mimeType: "image/png" },
          { type: "resource_link", uri: "file:///report.pdf" },
          { type: "text", text: "line two" },
        ],
      }),
    );
    expect(out).toEqual({ result: "ok", content: "line one\n[image]\n[resource file:///report.pdf]\nline two" });
  });

  it("marks a result the server itself called an error, and cuts a long one", () => {
    expect(JSON.parse(formatToolResult({ isError: true, content: [{ type: "text", text: "nope" }] }))).toMatchObject({
      result: "error",
      errorType: "tool_reported_error",
      content: "nope",
    });
    const long = JSON.parse(formatToolResult({ content: [{ type: "text", text: "x".repeat(20_000) }] }));
    expect(long.content.length).toBeLessThan(6200);
    expect(long.content).toContain("اقتطاع");
  });

  it("falls back to structured content when there is no text", () => {
    expect(JSON.parse(formatToolResult({ structuredContent: { id: 7 } })).content).toBe('{"id":7}');
  });

  it("describes a tool's fields briefly: type, whether required, fixed choices", () => {
    expect(summarizeFields(HUBSPOT_TOOLS[1].inputSchema)).toEqual([
      "email (string, required) - Contact's email",
      'stage (string) one of ["lead","customer"]',
    ]);
    expect(summarizeFields(undefined)).toEqual([]);
  });
});

describe("the handlers", () => {
  it("exist only for a person who has connected a server that agents may use", async () => {
    const user = await makeUser("a@example.test");
    expect(await createConnectorHandlers(user.id)).toBeUndefined();

    await server(user.id, "Private", { reusable: false });
    expect(await createConnectorHandlers(user.id)).toBeUndefined();

    await server(user.id, "HubSpot");
    expect((await createConnectorHandlers(user.id))?.servers).toEqual(["HubSpot"]);
  });

  it("finds the tools that match the words, says which write, and lists the fields", async () => {
    const user = await makeUser("a@example.test");
    await server(user.id, "HubSpot", { at: 1_000 });
    await server(user.id, "Notion", { at: 2_000 });
    const handlers = (await createConnectorHandlers(user.id))!;

    const found = JSON.parse(await handlers.find("create a contact"));
    expect(found.result).toBe("ok");
    expect(found.tools[0]).toMatchObject({ name: "hubspot__create_contact", server: "HubSpot", writes: true });
    expect(found.tools[0].fields).toEqual(["email (string, required) - Contact's email", 'stage (string) one of ["lead","customer"]']);
    const read = found.tools.find((t: { name: string }) => t.name === "hubspot__list_contacts");
    expect(read.writes).toBe(false);
    // The Notion tool does not match these words.
    expect(found.tools.map((t: { name: string }) => t.name)).not.toContain("notion__search_pages");
  });

  it("lists what exists when nothing matches or no words are given", async () => {
    const user = await makeUser("a@example.test");
    await server(user.id, "HubSpot");
    const handlers = (await createConnectorHandlers(user.id))!;

    for (const query of ["zzzz qqqq", ""]) {
      const found = JSON.parse(await handlers.find(query));
      expect(found.tools.map((t: { name: string }) => t.name).sort()).toEqual([
        "hubspot__create_contact",
        "hubspot__list_contacts",
      ]);
      expect(found.note).toBeTruthy();
    }
  });

  it("treats a tool as able to write unless its server says it only reads", async () => {
    const user = await makeUser("a@example.test");
    await server(user.id, "HubSpot");
    const handlers = (await createConnectorHandlers(user.id))!;
    expect(await handlers.writes("hubspot__list_contacts")).toBe(false); // readOnlyHint: true
    expect(await handlers.writes("hubspot__create_contact")).toBe(true); // says nothing
    expect(await handlers.writes("hubspot__nonexistent")).toBeUndefined();
    expect(await handlers.writes("stripe__refund")).toBeUndefined();
  });

  it("runs a call on the right server with that server's token, and formats the answer", async () => {
    const user = await makeUser("a@example.test");
    await server(user.id, "HubSpot");
    const handlers = (await createConnectorHandlers(user.id))!;

    const out = JSON.parse(await handlers.call("hubspot__create_contact", { email: "a@b.co" }));
    expect(out).toEqual({ result: "ok", content: "contact created" });
    expect(gatewayRuntime.callTool).toHaveBeenCalledWith(
      expect.objectContaining({ bearer: "HubSpot-token" }),
      "create_contact",
      { email: "a@b.co" },
    );
  });

  it("reports a server that failed in the gateway's own words, without the token", async () => {
    const user = await makeUser("a@example.test");
    await server(user.id, "HubSpot");
    gatewayRuntime.callTool = vi.fn(async () => {
      throw new McpError("The server took too long to answer.", "timeout");
    }) as unknown as typeof gatewayRuntime.callTool;
    const handlers = (await createConnectorHandlers(user.id))!;

    const text = await handlers.call("hubspot__create_contact", {});
    expect(JSON.parse(text)).toMatchObject({ result: "error", errorType: "tool_failed" });
    expect(text).toContain("HubSpot");
    expect(text).not.toContain("HubSpot-token");
  });

  it("will not call another person's tool", async () => {
    const mine = await makeUser("a@example.test");
    const theirs = await makeUser("b@example.test");
    await server(mine.id, "Notion");
    await server(theirs.id, "HubSpot");
    const handlers = (await createConnectorHandlers(mine.id))!;

    expect(await handlers.writes("hubspot__create_contact")).toBeUndefined();
    expect(JSON.parse(await handlers.call("hubspot__create_contact", {})).result).toBe("error");
    expect(gatewayRuntime.callTool).not.toHaveBeenCalled();
  });
});

// ------------------------------------------------------- a whole conversation

type Script = ModelReply[];

function scripted(replies: Script): ChatModel & { requests: ModelRequest[] } {
  const queue = [...replies];
  const requests: ModelRequest[] = [];
  return {
    name: "scripted",
    requests,
    async generate(request) {
      requests.push(structuredClone(request));
      const next = queue.shift();
      if (!next) throw new Error("called more times than scripted");
      return next;
    },
  };
}

const toolCall = (name: string, args: Record<string, unknown>, id: string) => ({ id, name, args });

describe("a conversation that adds a contact", () => {
  const CREATE = { name: "hubspot__create_contact", arguments: '{"email":"ahmed@example.com","stage":"lead"}' };

  async function setup() {
    const user = await makeUser("a@example.test");
    await server(user.id, "HubSpot");
    const thread = await prisma.thread.create({ data: { userId: user.id, title: "CRM" } });
    const ask = await prisma.message.create({ data: { threadId: thread.id, role: "USER", body: "أضف أحمد إلى HubSpot" } });
    return { user, thread, ask };
  }

  it("proposes first, and adds the contact only after the person says yes to those values", async () => {
    const { user, thread, ask } = await setup();

    // First message: find the tool, try to create the contact. Nothing may run yet.
    const first = scripted([
      { text: "", toolCalls: [toolCall(CONNECTOR_FIND_TOOL, { query: "create contact" }, "1")] },
      { text: "", toolCalls: [toolCall(CONNECTOR_CALL_TOOL, CREATE, "2")] },
      { text: "سأضيف ahmed@example.com كعميل محتمل في HubSpot. هل تؤكد؟", toolCalls: [] },
    ]);
    const proposal = await answerOnPlatform({
      userId: user.id,
      chatInput: "أضف أحمد (ahmed@example.com) إلى HubSpot",
      threadId: thread.id,
      currentMessageId: ask.id,
      models: [first],
    });
    expect(proposal).toContain("هل تؤكد");
    expect(gatewayRuntime.callTool).not.toHaveBeenCalled();
    expect(await prisma.orchestratorPendingAction.count({ where: { userId: user.id, status: "PENDING" } })).toBe(1);

    // The model was handed the tool, with the write flagged, in the first answer.
    const seen = JSON.stringify(first.requests[1].messages);
    expect(seen).toContain("hubspot__create_contact");
    expect(seen).toContain('\\"writes\\":true');

    // Second message: "yes". The model repeats the same call.
    await prisma.message.create({ data: { threadId: thread.id, role: "ASSISTANT", body: proposal } });
    const yes = await prisma.message.create({ data: { threadId: thread.id, role: "USER", body: "نعم" } });
    const second = scripted([
      { text: "", toolCalls: [toolCall(CONNECTOR_CALL_TOOL, CREATE, "3")] },
      { text: "تمت إضافة أحمد إلى HubSpot.", toolCalls: [] },
    ]);
    const done = await answerOnPlatform({
      userId: user.id,
      chatInput: "نعم",
      threadId: thread.id,
      currentMessageId: yes.id,
      models: [second],
    });

    expect(done).toContain("تمت إضافة");
    expect(gatewayRuntime.callTool).toHaveBeenCalledTimes(1);
    expect(gatewayRuntime.callTool).toHaveBeenCalledWith(
      expect.objectContaining({ bearer: "HubSpot-token" }),
      "create_contact",
      { email: "ahmed@example.com", stage: "lead" },
    );
    expect(await prisma.orchestratorPendingAction.count({ where: { userId: user.id, status: "CONSUMED" } })).toBe(1);
  });

  it("does not add the contact if the person's reply is not a plain yes", async () => {
    const { user, thread, ask } = await setup();
    await answerOnPlatform({
      userId: user.id,
      chatInput: "أضف أحمد",
      threadId: thread.id,
      currentMessageId: ask.id,
      models: [scripted([{ text: "", toolCalls: [toolCall(CONNECTOR_CALL_TOOL, CREATE, "1")] }, { text: "هل تؤكد؟", toolCalls: [] }])],
    });

    const reply = await prisma.message.create({ data: { threadId: thread.id, role: "USER", body: "نعم لكن غيّر البريد" } });
    await answerOnPlatform({
      userId: user.id,
      chatInput: "نعم لكن غيّر البريد",
      threadId: thread.id,
      currentMessageId: reply.id,
      models: [scripted([{ text: "", toolCalls: [toolCall(CONNECTOR_CALL_TOOL, CREATE, "2")] }, { text: "؟", toolCalls: [] }])],
    });
    expect(gatewayRuntime.callTool).not.toHaveBeenCalled();
  });

  it("does not offer the tools to a person with no server, and the rest of the turn works as before", async () => {
    const user = await makeUser("a@example.test");
    const model = scripted([{ text: "مرحباً", toolCalls: [] }]);
    expect(await answerOnPlatform({ userId: user.id, chatInput: "مرحباً", models: [model] })).toBe("مرحباً");
    expect(model.requests[0].tools.map((t) => t.name)).not.toContain(CONNECTOR_CALL_TOOL);
  });

  it("reads without asking: a tool that only reads runs at once", async () => {
    const { user, thread, ask } = await setup();
    const model = scripted([
      { text: "", toolCalls: [toolCall(CONNECTOR_CALL_TOOL, { name: "hubspot__list_contacts", arguments: '{"limit":3}' }, "1")] },
      { text: "عندك 3 جهات اتصال.", toolCalls: [] },
    ]);
    const answer = await answerOnPlatform({
      userId: user.id,
      chatInput: "اعرض جهات الاتصال",
      threadId: thread.id,
      currentMessageId: ask.id,
      models: [model],
    });
    expect(answer).toContain("3");
    expect(gatewayRuntime.callTool).toHaveBeenCalledWith(expect.anything(), "list_contacts", { limit: 3 });
    expect(await prisma.orchestratorPendingAction.count()).toBe(0);
  });
});
