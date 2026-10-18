import {
  ModelUnavailableError,
  type ChatMessage,
  type ChatModel,
  type ModelReply,
  type ModelRequest,
  type ToolCall,
  type ToolSpec,
} from "./model";
import { orchestratorSystemPrompt } from "./prompt";
import type { ConfirmationGate } from "./confirmations";

/**
 * One user turn: ask the model, run whatever tools it asks for, feed the results
 * back, and stop when it answers in plain text.
 *
 * Provider-neutral on purpose. It takes an ordered list of ChatModels and moves to
 * the next one only when the current one is unavailable, so a provider change is a
 * new adapter, not an edit here.
 */

export const MAX_STEPS = 6;

export const RUN_TOOL = "run_marketplace_tool";
export const SEARCH_TOOL = "web_search";

export const STEP_LIMIT_REPLY =
  "لم أتمكن من إكمال هذا الطلب ضمن عدد الخطوات المسموح به. جرّب صياغته بشكل أبسط.";

export const TOOL_SPECS: ToolSpec[] = [
  {
    name: RUN_TOOL,
    description:
      "ينفّذ أداة مفعّلة للمستخدم. مرّر installationId من قائمة الأدوات المتاحة في رسالة النظام، ومرّر args كسلسلة نصية JSON (string وليس كائناً) تحتوي الحقول التي طلبها المستخدم، مثل {\"chatInput\":\"...\"}. لا تستدعِ هذه الأداة قبل اكتمال الحقول المطلوبة، ولا قبل تأكيد المستخدم إذا كان نوع الإجراء write.",
    parameters: {
      type: "object",
      properties: {
        installationId: {
          type: "string",
          description: "رقم التفعيل للأداة المختارة من قائمة الأدوات المتاحة.",
        },
        args: {
          type: "string",
          description:
            'سلسلة نصية (string) بصيغة JSON تحتوي الحقول المطلوبة، وليست كائناً. مثال: {"chatInput":"سؤال المستخدم كما هو"}',
        },
      },
      required: ["installationId", "args"],
    },
  },
  {
    name: SEARCH_TOOL,
    description:
      "يبحث في الإنترنت (DuckDuckGo) ويعيد قائمة نتائج بعناوينها وروابطها وتواريخها ومقتطفات منها. استعمله للمعلومات التي تتغير مع الزمن (إصدارات، أخبار، أسعار، أنظمة) أو حين يطلب المستخدم البحث في الإنترنت، أو حين لا تجد أداة الملفات الجواب. المدخل: استعلام بحث قصير، ويفضل بالإنجليزية للمواضيع التقنية. طريقة قراءة النتائج: قد تتضمن صفحات قديمة، فقارن بين كل النتائج ولا تعتمد على أولها؛ للإصدارات والتواريخ خذ الأحدث تاريخاً والأعلى رقم إصدار، وصرّح بالتاريخ الذي ظهر في النتيجة. لا تستعمله لأسئلة ملفات المستخدم.",
    parameters: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "استعلام البحث على الإنترنت: كلمات قليلة ومحددة.",
        },
      },
      required: ["query"],
    },
  },
];

export type ToolHandlers = {
  runMarketplaceTool(installationId: string, args: Record<string, unknown>): Promise<string>;
  webSearch(query: string): Promise<string>;
};

export type TurnInput = {
  /** Tried in order. The next one answers only if the current one is unavailable. */
  models: ChatModel[];
  /** The rendered catalog from catalog.ts, placed into the system prompt. */
  catalogText: string;
  /** The installations the user actually has, and whether each one is a read or a write. Any other id is refused. */
  actionTypes: ReadonlyMap<string, "read" | "write">;
  /** Decides whether a write may run. A write runs only after the person has confirmed it. */
  confirmations: ConfirmationGate;
  history: ChatMessage[];
  userMessage: string;
  now: Date;
  handlers: ToolHandlers;
};

function failure(errorType: string): string {
  return JSON.stringify({ result: "error", errorType });
}

function parseArgs(value: unknown): Record<string, unknown> | null {
  let parsed: unknown = value;
  if (typeof value === "string") {
    try {
      parsed = JSON.parse(value);
    } catch {
      return null;
    }
  }
  return parsed && typeof parsed === "object" && !Array.isArray(parsed)
    ? (parsed as Record<string, unknown>)
    : null;
}

async function execute(call: ToolCall, input: TurnInput): Promise<string> {
  try {
    if (call.name === SEARCH_TOOL) {
      const query = typeof call.args.query === "string" ? call.args.query.trim() : "";
      return query ? await input.handlers.webSearch(query) : failure("invalid_arguments");
    }

    if (call.name === RUN_TOOL) {
      const installationId = call.args.installationId;
      const actionType = typeof installationId === "string" ? input.actionTypes.get(installationId) : undefined;
      if (typeof installationId !== "string" || !actionType) return failure("unknown_installation");
      const args = parseArgs(call.args.args);
      if (!args) return failure("invalid_arguments");

      if (actionType === "write" && !(await input.confirmations.confirmed(installationId, args))) {
        await input.confirmations.propose(installationId, args);
        return JSON.stringify({
          result: "needs_confirmation",
          message: "لم يُنفَّذ الإجراء بعد. اعرض القيم على المستخدم واطلب تأكيده في رسالته التالية.",
        });
      }
      return await input.handlers.runMarketplaceTool(installationId, args);
    }

    return failure("unknown_tool");
  } catch (error) {
    console.error(`Orchestrator tool ${call.name} failed`, error);
    return failure("tool_failed");
  }
}

async function generate(models: ChatModel[], request: ModelRequest): Promise<ModelReply> {
  let lastError: unknown;
  for (const model of models) {
    try {
      return await model.generate(request);
    } catch (error) {
      if (!(error instanceof ModelUnavailableError)) throw error;
      console.error(`Orchestrator model ${model.name} unavailable`, error);
      lastError = error;
    }
  }
  throw lastError;
}

export async function runOrchestratorTurn(input: TurnInput): Promise<string> {
  if (input.models.length === 0) throw new Error("runOrchestratorTurn needs at least one model");

  const system = orchestratorSystemPrompt({ catalogText: input.catalogText, now: input.now });
  const messages: ChatMessage[] = [...input.history, { role: "user", content: input.userMessage }];

  for (let step = 0; step < MAX_STEPS; step++) {
    const reply = await generate(input.models, { system, messages, tools: TOOL_SPECS });
    if (reply.toolCalls.length === 0) return reply.text;

    messages.push({ role: "assistant", content: reply.text, toolCalls: reply.toolCalls });
    for (const call of reply.toolCalls) {
      messages.push({
        role: "tool",
        toolCallId: call.id,
        name: call.name,
        content: await execute(call, input),
      });
    }
  }

  return STEP_LIMIT_REPLY;
}
