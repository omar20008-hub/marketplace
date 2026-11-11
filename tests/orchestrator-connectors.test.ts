import { describe, expect, it, vi } from "vitest";
import type { ConfirmationGate } from "@/server/orchestrator/confirmations";
import { NO_CONFIRMATION, argsKey } from "@/server/orchestrator/confirmations";
import {
  CONNECTOR_CALL_TOOL,
  CONNECTOR_FIND_TOOL,
  runOrchestratorTurn,
  type ConnectorHandlers,
  type ToolHandlers,
  type TurnInput,
} from "@/server/orchestrator/engine";
import type { ChatModel, ModelReply, ModelRequest } from "@/server/orchestrator/model";

/**
 * The tools that reach a person's connected MCP servers, at the engine. The promises:
 * they are offered only when the person has a server; a tool that changes something
 * never runs without the person's confirmation of those exact values, however the model
 * behaves; and a name the person does not have is refused.
 */

const NOW = new Date("2026-10-20T09:30:00.000Z");

const reply = (text: string, toolCalls: ModelReply["toolCalls"] = []): ModelReply => ({ text, toolCalls });
const call = (name: string, args: Record<string, unknown>, id = `c_${Math.random()}`) => ({ id, name, args });

function scripted(replies: ModelReply[]) {
  const requests: ModelRequest[] = [];
  const queue = [...replies];
  const model: ChatModel & { requests: ModelRequest[] } = {
    name: "m",
    requests,
    async generate(request) {
      requests.push(structuredClone(request));
      const next = queue.shift();
      if (!next) throw new Error("called more times than scripted");
      return next;
    },
  };
  return model;
}

/** Two tools: one that only reads, one that writes. */
function connectors(overrides: Partial<ConnectorHandlers> = {}): ConnectorHandlers & {
  find: ReturnType<typeof vi.fn>;
  call: ReturnType<typeof vi.fn>;
} {
  const kinds: Record<string, boolean> = { hubspot__list_contacts: false, hubspot__create_contact: true };
  return {
    servers: ["HubSpot"],
    find: vi.fn(async () => JSON.stringify({ result: "ok", tools: [{ name: "hubspot__create_contact", writes: true }] })),
    writes: vi.fn(async (name: string) => kinds[name]),
    call: vi.fn(async () => JSON.stringify({ result: "ok", content: "done" })),
    ...overrides,
  } as never;
}

function turn(models: ChatModel[], handlers: Partial<ToolHandlers>, extra: Partial<TurnInput> = {}): TurnInput {
  return {
    models,
    catalogText: "لا توجد أدوات مفعّلة لهذا المستخدم.",
    actionTypes: new Map(),
    confirmations: NO_CONFIRMATION,
    history: [],
    userMessage: "أضف أحمد إلى HubSpot",
    now: NOW,
    handlers: {
      runMarketplaceTool: vi.fn(async () => "{}"),
      webSearch: vi.fn(async () => "{}"),
      ...handlers,
    },
    ...extra,
  };
}

/** A gate that behaves like the stored one: a write is confirmed only if proposed before and the person said yes. */
function memoryGate() {
  const proposed = new Set<string>();
  const state = { affirmed: false, proposals: [] as { id: string; args: Record<string, unknown> }[] };
  const gate: ConfirmationGate = {
    async propose(id, args) {
      proposed.add(`${id}|${argsKey(args)}`);
      state.proposals.push({ id, args });
    },
    async confirmed(id, args) {
      const key = `${id}|${argsKey(args)}`;
      if (!state.affirmed || !proposed.has(key)) return false;
      proposed.delete(key);
      return true;
    },
  };
  return { gate, state };
}

const toolNames = (request: ModelRequest) => request.tools.map((tool) => tool.name);

describe("when the tools are offered", () => {
  it("does not offer them, or mention them, to a person with no connected server", async () => {
    const model = scripted([reply("مرحباً")]);
    await runOrchestratorTurn(turn([model], {}));

    expect(toolNames(model.requests[0])).not.toContain(CONNECTOR_FIND_TOOL);
    expect(toolNames(model.requests[0])).not.toContain(CONNECTOR_CALL_TOOL);
    expect(model.requests[0].system).not.toContain("الخدمات المتصلة");
  });

  it("offers both, and names the servers in the prompt, to a person who has one", async () => {
    const model = scripted([reply("مرحباً")]);
    await runOrchestratorTurn(turn([model], { connectors: connectors({ servers: ["HubSpot", "Notion"] }) }));

    expect(toolNames(model.requests[0])).toEqual(expect.arrayContaining([CONNECTOR_FIND_TOOL, CONNECTOR_CALL_TOOL]));
    expect(model.requests[0].system).toContain("HubSpot، Notion");
    expect(model.requests[0].system).toContain("writes: true");
  });

  it("leaves the rest of the prompt exactly as it was for a person without a server", async () => {
    const without = scripted([reply("a")]);
    await runOrchestratorTurn(turn([without], {}));
    const withServer = scripted([reply("a")]);
    await runOrchestratorTurn(turn([withServer], { connectors: connectors() }));

    expect(withServer.requests[0].system.startsWith(without.requests[0].system)).toBe(true);
    expect(withServer.requests[0].system.length).toBeGreaterThan(without.requests[0].system.length);
  });
});

describe("finding tools", () => {
  it("passes the question on and gives the model what came back", async () => {
    const handlers = connectors();
    const model = scripted([
      reply("", [call(CONNECTOR_FIND_TOOL, { query: "add contact" }, "f1")]),
      reply("وجدت أداة لذلك"),
    ]);
    await runOrchestratorTurn(turn([model], { connectors: handlers }));

    expect(handlers.find).toHaveBeenCalledWith("add contact");
    const toolMessage = model.requests[1].messages.find((m) => m.role === "tool");
    expect(toolMessage && "content" in toolMessage && toolMessage.content).toContain("hubspot__create_contact");
  });
});

describe("calling a tool that only reads", () => {
  it("runs straight away, without asking the person", async () => {
    const handlers = connectors();
    const { gate } = memoryGate();
    const propose = vi.spyOn(gate, "propose");
    const model = scripted([
      reply("", [call(CONNECTOR_CALL_TOOL, { name: "hubspot__list_contacts", arguments: '{"limit":5}' })]),
      reply("هذه جهات الاتصال"),
    ]);
    await runOrchestratorTurn(turn([model], { connectors: handlers }, { confirmations: gate }));

    expect(handlers.call).toHaveBeenCalledWith("hubspot__list_contacts", { limit: 5 });
    expect(propose).not.toHaveBeenCalled();
  });

  it("accepts the arguments already as an object, and none at all", async () => {
    const handlers = connectors();
    const model = scripted([
      reply("", [
        call(CONNECTOR_CALL_TOOL, { name: "hubspot__list_contacts", arguments: { limit: 2 } }, "a"),
        call(CONNECTOR_CALL_TOOL, { name: "hubspot__list_contacts" }, "b"),
      ]),
      reply("تم"),
    ]);
    await runOrchestratorTurn(turn([model], { connectors: handlers }));
    expect(handlers.call).toHaveBeenNthCalledWith(1, "hubspot__list_contacts", { limit: 2 });
    expect(handlers.call).toHaveBeenNthCalledWith(2, "hubspot__list_contacts", {});
  });
});

describe("calling a tool that changes something", () => {
  const WRITE = { name: "hubspot__create_contact", arguments: '{"email":"a@b.co","name":"أحمد"}' };

  it("does not run it, and asks for confirmation of exactly those values", async () => {
    const handlers = connectors();
    const { gate, state } = memoryGate();
    const model = scripted([reply("", [call(CONNECTOR_CALL_TOOL, WRITE)]), reply("هل تؤكد؟")]);
    await runOrchestratorTurn(turn([model], { connectors: handlers }, { confirmations: gate }));

    expect(handlers.call).not.toHaveBeenCalled();
    expect(state.proposals).toEqual([{ id: "mcp:hubspot__create_contact", args: { email: "a@b.co", name: "أحمد" } }]);

    const toolMessage = model.requests[1].messages.find((m) => m.role === "tool");
    const content = JSON.parse(toolMessage && "content" in toolMessage ? toolMessage.content : "{}");
    expect(content).toMatchObject({
      result: "needs_confirmation",
      tool: "hubspot__create_contact",
      arguments: { email: "a@b.co", name: "أحمد" },
    });
  });

  it("runs it after the person has said yes to those same values, and only once", async () => {
    const handlers = connectors();
    const { gate, state } = memoryGate();

    // First message: the proposal.
    await runOrchestratorTurn(
      turn([scripted([reply("", [call(CONNECTOR_CALL_TOOL, WRITE)]), reply("هل تؤكد؟")])], { connectors: handlers }, { confirmations: gate }),
    );
    expect(handlers.call).not.toHaveBeenCalled();

    // Next message: "yes", and the model calls it again with the same values.
    state.affirmed = true;
    await runOrchestratorTurn(
      turn([scripted([reply("", [call(CONNECTOR_CALL_TOOL, WRITE)]), reply("تمت الإضافة")])], { connectors: handlers }, {
        confirmations: gate,
        userMessage: "نعم",
      }),
    );
    expect(handlers.call).toHaveBeenCalledTimes(1);
    expect(handlers.call).toHaveBeenCalledWith("hubspot__create_contact", { email: "a@b.co", name: "أحمد" });

    // The confirmation was used up: the same call again needs a new one.
    await runOrchestratorTurn(
      turn([scripted([reply("", [call(CONNECTOR_CALL_TOOL, WRITE)]), reply("؟")])], { connectors: handlers }, {
        confirmations: gate,
        userMessage: "نعم",
      }),
    );
    expect(handlers.call).toHaveBeenCalledTimes(1);
  });

  it("asks again when the values changed after the person confirmed", async () => {
    const handlers = connectors();
    const { gate, state } = memoryGate();
    await runOrchestratorTurn(
      turn([scripted([reply("", [call(CONNECTOR_CALL_TOOL, WRITE)]), reply("؟")])], { connectors: handlers }, { confirmations: gate }),
    );

    state.affirmed = true;
    const changed = { ...WRITE, arguments: '{"email":"someone-else@b.co","name":"أحمد"}' };
    await runOrchestratorTurn(
      turn([scripted([reply("", [call(CONNECTOR_CALL_TOOL, changed)]), reply("؟")])], { connectors: handlers }, {
        confirmations: gate,
        userMessage: "نعم",
      }),
    );
    expect(handlers.call).not.toHaveBeenCalled();
  });

  it("never runs it where nothing can be confirmed, however the model behaves", async () => {
    const handlers = connectors();
    const model = scripted([reply("", [call(CONNECTOR_CALL_TOOL, WRITE)]), reply("؟")]);
    await runOrchestratorTurn(turn([model], { connectors: handlers }, { confirmations: NO_CONFIRMATION, userMessage: "نعم" }));
    expect(handlers.call).not.toHaveBeenCalled();
  });
});

describe("refusals", () => {
  const result = async (handlers: ConnectorHandlers, args: Record<string, unknown>) => {
    const model = scripted([reply("", [call(CONNECTOR_CALL_TOOL, args)]), reply("ok")]);
    await runOrchestratorTurn(turn([model], { connectors: handlers }));
    const message = model.requests[1].messages.find((m) => m.role === "tool");
    return JSON.parse(message && "content" in message ? message.content : "{}");
  };

  it("refuses a tool the person does not have, without proposing or running anything", async () => {
    const handlers = connectors();
    const { gate, state } = memoryGate();
    const model = scripted([reply("", [call(CONNECTOR_CALL_TOOL, { name: "stripe__refund_all", arguments: "{}" })]), reply("ok")]);
    await runOrchestratorTurn(turn([model], { connectors: handlers }, { confirmations: gate }));

    expect(handlers.call).not.toHaveBeenCalled();
    expect(state.proposals).toEqual([]);
    const message = model.requests[1].messages.find((m) => m.role === "tool");
    expect(JSON.parse(message && "content" in message ? message.content : "{}")).toMatchObject({
      result: "error",
      errorType: "unknown_tool",
    });
  });

  it("refuses arguments that are not a JSON object, and a missing name", async () => {
    const handlers = connectors();
    expect(await result(handlers, { name: "hubspot__list_contacts", arguments: "[1,2]" })).toMatchObject({
      errorType: "invalid_arguments",
    });
    expect(await result(handlers, { name: "hubspot__list_contacts", arguments: "not json" })).toMatchObject({
      errorType: "invalid_arguments",
    });
    expect(await result(handlers, { arguments: "{}" })).toMatchObject({ errorType: "invalid_arguments" });
    expect(handlers.call).not.toHaveBeenCalled();
  });

  it("refuses both tools when the person has no server, even if the model names them anyway", async () => {
    const model = scripted([
      reply("", [call(CONNECTOR_CALL_TOOL, { name: "x__y", arguments: "{}" }, "1"), call(CONNECTOR_FIND_TOOL, { query: "z" }, "2")]),
      reply("ok"),
    ]);
    await runOrchestratorTurn(turn([model], {}));
    const messages = model.requests[1].messages.filter((m) => m.role === "tool");
    expect(messages).toHaveLength(2);
    for (const message of messages) {
      expect(JSON.parse("content" in message ? message.content : "{}")).toMatchObject({ errorType: "unknown_tool" });
    }
  });

  it("reports a tool that throws as a failure, not as a crash", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const handlers = connectors({
      call: vi.fn(async () => {
        throw new Error("boom");
      }),
    });
    expect(await result(handlers, { name: "hubspot__list_contacts", arguments: "{}" })).toMatchObject({
      result: "error",
      errorType: "tool_failed",
    });
  });
});
