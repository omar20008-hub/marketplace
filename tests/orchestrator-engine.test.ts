import { describe, expect, it, vi } from "vitest";
import {
  MAX_STEPS,
  STEP_LIMIT_REPLY,
  runOrchestratorTurn,
  type ToolHandlers,
  type TurnInput,
} from "@/server/orchestrator/engine";
import {
  ModelError,
  ModelUnavailableError,
  type ChatModel,
  type ModelReply,
  type ModelRequest,
} from "@/server/orchestrator/model";

/**
 * The turn loop with scripted models. The engine is tested against ChatModel, not
 * against any provider, which is the point: a new provider has to pass these
 * same cases through its own adapter.
 */

const NOW = new Date("2026-10-20T09:30:00.000Z");
const ALLOWED = new Set(["inst_mine"]);

function reply(text: string, toolCalls: ModelReply["toolCalls"] = []): ModelReply {
  return { text, toolCalls };
}

function call(name: string, args: Record<string, unknown>, id = `c_${Math.random()}`) {
  return { id, name, args };
}

function scripted(name: string, replies: (ModelReply | Error)[]) {
  const requests: ModelRequest[] = [];
  const queue = [...replies];
  const model: ChatModel & { requests: ModelRequest[] } = {
    name,
    requests,
    async generate(request) {
      requests.push(structuredClone(request));
      const next = queue.shift();
      if (!next) throw new Error(`${name} was called more times than scripted`);
      if (next instanceof Error) throw next;
      return next;
    },
  };
  return model;
}

function handlers(overrides: Partial<ToolHandlers> = {}) {
  const value: ToolHandlers = {
    runMarketplaceTool: vi.fn(async () => JSON.stringify({ result: "success", toolOutput: "ok" })),
    webSearch: vi.fn(async () => "نتيجة بحث"),
    ...overrides,
  };
  return value;
}

function turn(overrides: Partial<TurnInput> & { models: ChatModel[] }): TurnInput {
  return {
    catalogText: "- installationId: inst_mine | الاسم: Digest",
    allowedInstallationIds: ALLOWED,
    history: [],
    userMessage: "ما أخبار الأسبوع؟",
    now: NOW,
    handlers: handlers(),
    ...overrides,
  };
}

describe("runOrchestratorTurn — answers", () => {
  it("returns a plain answer without calling any tool", async () => {
    const model = scripted("m", [reply("مرحباً")]);
    const h = handlers();

    const answer = await runOrchestratorTurn(turn({ models: [model], handlers: h }));

    expect(answer).toBe("مرحباً");
    expect(h.runMarketplaceTool).not.toHaveBeenCalled();
    expect(h.webSearch).not.toHaveBeenCalled();
  });

  it("runs a tool the user owns, feeds the result back, and returns the next answer", async () => {
    const model = scripted("m", [
      reply("", [call("run_marketplace_tool", { installationId: "inst_mine", args: '{"chatInput":"x"}' })]),
      reply("إليك النتيجة"),
    ]);
    const h = handlers();

    const answer = await runOrchestratorTurn(turn({ models: [model], handlers: h }));

    expect(answer).toBe("إليك النتيجة");
    expect(h.runMarketplaceTool).toHaveBeenCalledWith("inst_mine", { chatInput: "x" });
    const second = model.requests[1].messages.at(-1);
    expect(second).toMatchObject({ role: "tool", name: "run_marketplace_tool" });
    expect(second?.role === "tool" && second.content).toContain('"toolOutput":"ok"');
  });

  it("gives the model the system prompt with the catalog and the UTC time", async () => {
    const model = scripted("m", [reply("ok")]);

    await runOrchestratorTurn(turn({ models: [model] }));

    const system = model.requests[0].system;
    expect(system).toContain("- installationId: inst_mine | الاسم: Digest");
    expect(system).toContain("2026-10-20T09:30:00.000Z");
    expect(system).not.toContain("{{");
  });

  it("sends earlier messages in order before the new one", async () => {
    const model = scripted("m", [reply("ok")]);

    await runOrchestratorTurn(
      turn({
        models: [model],
        history: [
          { role: "user", content: "أول" },
          { role: "assistant", content: "رد", toolCalls: [] },
        ],
        userMessage: "ثاني",
      }),
    );

    expect(model.requests[0].messages.map((m) => m.role)).toEqual(["user", "assistant", "user"]);
    expect(model.requests[0].messages.at(-1)).toEqual({ role: "user", content: "ثاني" });
  });
});

describe("runOrchestratorTurn — the installation check", () => {
  it("never runs an installation the user does not have", async () => {
    const model = scripted("m", [
      reply("", [call("run_marketplace_tool", { installationId: "inst_someone_else", args: "{}" })]),
      reply("لا أستطيع"),
    ]);
    const h = handlers();

    await runOrchestratorTurn(turn({ models: [model], handlers: h }));

    expect(h.runMarketplaceTool).not.toHaveBeenCalled();
    const result = model.requests[1].messages.at(-1);
    expect(result?.role === "tool" && result.content).toContain("unknown_installation");
  });

  it("refuses arguments that are not a JSON object, without running the tool", async () => {
    const model = scripted("m", [
      reply("", [call("run_marketplace_tool", { installationId: "inst_mine", args: "not json" })]),
      reply("تعذّر"),
    ]);
    const h = handlers();

    await runOrchestratorTurn(turn({ models: [model], handlers: h }));

    expect(h.runMarketplaceTool).not.toHaveBeenCalled();
    const result = model.requests[1].messages.at(-1);
    expect(result?.role === "tool" && result.content).toContain("invalid_arguments");
  });

  it("reports a tool that throws as a failure and keeps the turn going", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const model = scripted("m", [
      reply("", [call("run_marketplace_tool", { installationId: "inst_mine", args: "{}" })]),
      reply("حدث خطأ"),
    ]);
    const h = handlers({
      runMarketplaceTool: vi.fn(async () => {
        throw new Error("dispatcher down");
      }),
    });

    const answer = await runOrchestratorTurn(turn({ models: [model], handlers: h }));

    expect(answer).toBe("حدث خطأ");
    const result = model.requests[1].messages.at(-1);
    expect(result?.role === "tool" && result.content).toContain("tool_failed");
  });
});

describe("runOrchestratorTurn — limits", () => {
  it("stops after the step limit instead of looping", async () => {
    const forever = Array.from({ length: MAX_STEPS + 2 }, () =>
      reply("", [call("web_search", { query: "q" })]),
    );
    const model = scripted("m", forever);
    const h = handlers();

    const answer = await runOrchestratorTurn(turn({ models: [model], handlers: h }));

    expect(answer).toBe(STEP_LIMIT_REPLY);
    expect(model.requests).toHaveLength(MAX_STEPS);
    expect(h.webSearch).toHaveBeenCalledTimes(MAX_STEPS);
  });
});

describe("runOrchestratorTurn — fallback between models", () => {
  it("moves to the next model when the first is unavailable", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const primary = scripted("primary", [new ModelUnavailableError("503")]);
    const fallback = scripted("fallback", [reply("من الاحتياطي")]);

    const answer = await runOrchestratorTurn(turn({ models: [primary, fallback] }));

    expect(answer).toBe("من الاحتياطي");
    expect(primary.requests).toHaveLength(1);
    expect(fallback.requests).toHaveLength(1);
  });

  it("does not fall back on a refusal that another model would also hit", async () => {
    const primary = scripted("primary", [new ModelError("400 bad request")]);
    const fallback = scripted("fallback", [reply("unused")]);

    await expect(runOrchestratorTurn(turn({ models: [primary, fallback] }))).rejects.toThrow(
      "400 bad request",
    );
    expect(fallback.requests).toHaveLength(0);
  });

  it("throws the unavailable error when every model is unavailable", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const a = scripted("a", [new ModelUnavailableError("a down")]);
    const b = scripted("b", [new ModelUnavailableError("b down")]);

    await expect(runOrchestratorTurn(turn({ models: [a, b] }))).rejects.toBeInstanceOf(
      ModelUnavailableError,
    );
  });

  it("needs at least one model", async () => {
    await expect(runOrchestratorTurn(turn({ models: [] }))).rejects.toThrow("at least one model");
  });
});
