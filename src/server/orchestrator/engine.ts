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
export const HISTORY_TOOL = "search_conversation";
/** The two tools that reach the MCP servers a person connected. Offered only when they have one. */
export const CONNECTOR_FIND_TOOL = "find_connector_tools";
export const CONNECTOR_CALL_TOOL = "call_connector_tool";

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
  {
    name: HISTORY_TOOL,
    description:
      "يبحث في كل محادثات المستخدم السابقة مع المساعد، في المنصة والواتساب، ويعيد الرسائل المطابقة بتاريخها وقناتها. استعمله حين يشير المستخدم إلى شيء قاله أو أرسله أو طلبه سابقاً ولا تجده في آخر المحادثة ولا في ملخصها (مثل «الوظيفة التي ذكرتها»، «العنوان الذي أعطيتك»). المدخل: كلمات قليلة تصف ما تبحث عنه.",
    parameters: {
      type: "object",
      properties: {
        query: { type: "string", description: "ما تبحث عنه في المحادثات السابقة: كلمات قليلة ومحددة." },
      },
      required: ["query"],
    },
  },
];

export const CONNECTOR_TOOL_SPECS: ToolSpec[] = [
  {
    name: CONNECTOR_FIND_TOOL,
    description:
      "يبحث في أدوات الخدمات التي ربطها المستخدم (خوادم MCP) ويعيد الأدوات المطابقة باسمها وخدمتها ووصفها وحقولها، وهل تغيّر شيئاً (writes). استعمله قبل أي عمل على خدمة خارجية متصلة: إنشاء، إضافة، تعديل، إرسال، أو قراءة بيانات من حساب المستخدم في تلك الخدمة. المدخل: كلمات قليلة تصف المطلوب. اترك الاستعلام فارغاً لعرض ما هو متاح.",
    parameters: {
      type: "object",
      properties: {
        query: { type: "string", description: "ما تريد فعله أو الخدمة المقصودة: كلمات قليلة ومحددة." },
      },
      required: ["query"],
    },
  },
  {
    name: CONNECTOR_CALL_TOOL,
    description:
      "ينفّذ أداة من أدوات الخدمات المتصلة. مرّر name كما ظهر في نتيجة find_connector_tools حرفياً، ومرّر arguments كسلسلة نصية JSON (string وليس كائناً) بالحقول التي طلبتها الأداة. لا تستدعِ أداة غير ظاهرة في نتيجة البحث، ولا قبل اكتمال الحقول المطلوبة. الأداة التي تغيّر شيئاً (writes: true) لا تُنفَّذ إلا بعد أن يؤكد المستخدم القيم نفسها.",
    parameters: {
      type: "object",
      properties: {
        name: { type: "string", description: "اسم الأداة كما ظهر في نتيجة البحث." },
        arguments: {
          type: "string",
          description: 'سلسلة نصية (string) بصيغة JSON بحقول الأداة، وليست كائناً. مثال: {"title":"حملة الخريف"}',
        },
      },
      required: ["name", "arguments"],
    },
  },
];

/** The MCP servers the person connected, as the engine uses them. See runtimes/connectors.ts. */
export type ConnectorHandlers = {
  /** Their names, for the system prompt. Never empty: with no servers there are no handlers. */
  servers: string[];
  /** The matching tools, as JSON for the model. */
  find(query: string): Promise<string>;
  /** Whether a tool may change something outside. Undefined when the person has no such tool. */
  writes(name: string): Promise<boolean | undefined>;
  /** Runs a tool and returns what the model should see. The engine has already asked the gate. */
  call(name: string, args: Record<string, unknown>): Promise<string>;
};

export type ToolHandlers = {
  runMarketplaceTool(installationId: string, args: Record<string, unknown>): Promise<string>;
  webSearch(query: string): Promise<string>;
  /** Searches the person's past conversations. Absent where there is no person (a guest). */
  searchConversation?(query: string): Promise<string>;
  /** Absent when the person has connected no MCP server, which is also when the tools are not offered. */
  connectors?: ConnectorHandlers;
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

    if (call.name === HISTORY_TOOL) {
      const query = typeof call.args.query === "string" ? call.args.query.trim() : "";
      if (!input.handlers.searchConversation) return failure("unknown_tool");
      return query ? await input.handlers.searchConversation(query) : failure("invalid_arguments");
    }

    if (call.name === CONNECTOR_FIND_TOOL) {
      const connectors = input.handlers.connectors;
      if (!connectors) return failure("unknown_tool");
      const query = typeof call.args.query === "string" ? call.args.query.trim() : "";
      return await connectors.find(query);
    }

    if (call.name === CONNECTOR_CALL_TOOL) {
      const connectors = input.handlers.connectors;
      if (!connectors) return failure("unknown_tool");
      const name = typeof call.args.name === "string" ? call.args.name.trim() : "";
      if (!name) return failure("invalid_arguments");
      const raw = call.args.arguments;
      const args = raw === undefined || raw === "" ? {} : parseArgs(raw);
      if (!args) return failure("invalid_arguments");

      // Only a tool the person actually has can be called, and a model cannot name its way around that.
      const writes = await connectors.writes(name);
      if (writes === undefined) return failure("unknown_tool");

      if (writes) {
        // The gate keys on the tool and its exact arguments, as it does for an installed product.
        const key = `mcp:${name}`;
        if (!(await input.confirmations.confirmed(key, args))) {
          await input.confirmations.propose(key, args);
          return JSON.stringify({
            result: "needs_confirmation",
            tool: name,
            arguments: args,
            message: "لم يُنفَّذ الإجراء بعد. اعرض اسم الأداة والقيم أعلاه كما هي على المستخدم واطلب تأكيده في رسالته التالية.",
          });
        }
      }
      return await connectors.call(name, args);
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

  const connectors = input.handlers.connectors;
  const system = orchestratorSystemPrompt({
    catalogText: input.catalogText,
    now: input.now,
    connectorServers: connectors?.servers,
  });
  const tools = connectors ? [...TOOL_SPECS, ...CONNECTOR_TOOL_SPECS] : TOOL_SPECS;
  const messages: ChatMessage[] = [...input.history, { role: "user", content: input.userMessage }];

  for (let step = 0; step < MAX_STEPS; step++) {
    const reply = await generate(input.models, { system, messages, tools });
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
