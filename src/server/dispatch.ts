import "server-only";
import { n8n, type DispatchOutput } from "@/lib/n8n";
import { isOnDemand } from "@/lib/invocation-mode";

/**
 * What the MP · Dispatcher workflow did before a product copy runs, now in the
 * platform: a copy is only run when it can be called from a conversation, every
 * input the product asks for is present, and the output comes back in the shape
 * the Orchestrator reads.
 *
 * Ownership, readiness, the plan allowance and the failure count are checked by
 * executeRun() before this is reached, and the run itself is recorded there.
 */

type SchemaField = { name: string; system?: boolean };

const OUTPUT_ITEMS = 3;
const OUTPUT_CHARS = 4000;

export type DispatchRequest = {
  userId: string;
  /** The id the n8n copy knows this installation by. */
  installationId: string;
  instanceWorkflowId: string | null;
  invocationMode: string;
  title: string;
  inputSchema: unknown;
  args: Record<string, unknown>;
};

function isEmpty(value: unknown): boolean {
  return value === undefined || value === null || value === "";
}

export function wrapOutput(items: Record<string, unknown>[]): string {
  const payload = JSON.stringify(items.slice(0, OUTPUT_ITEMS));
  return payload.length > OUTPUT_CHARS ? `${payload.slice(0, OUTPUT_CHARS)}...[truncated]` : payload;
}

export async function dispatchInstance(request: DispatchRequest): Promise<DispatchOutput> {
  if (!request.instanceWorkflowId) {
    return { result: "denied", reason: "لا يوجد تفعيل مطابق لهذا المستخدم، أو أن التفعيل موقوف" };
  }

  if (!isOnDemand(request.invocationMode)) {
    return {
      result: "denied",
      reason: `الأداة "${request.title}" تعمل تلقائياً بالجدولة أو عند وقوع حدث، ولا تُستدعى من المحادثة.`,
    };
  }

  const schema = Array.isArray(request.inputSchema) ? (request.inputSchema as SchemaField[]) : [];
  const args: Record<string, unknown> = { ...request.args };
  for (const field of schema) {
    if (field.system && field.name === "sessionId" && isEmpty(args.sessionId)) {
      args.sessionId = `${request.userId}:${request.installationId}`;
    }
  }

  const missing = schema
    .filter((field) => !field.system)
    .map((field) => field.name)
    .filter((name) => isEmpty(args[name]));
  if (missing.length > 0) {
    return {
      result: "incomplete",
      missing: missing.join(","),
      message: `الحقول الناقصة لتنفيذ "${request.title}": ${missing.join(", ")}. اطلب هذه القيم من المستخدم ولا تخمّنها.`,
    };
  }

  const outcome = await n8n.runInstance(request.instanceWorkflowId, args);
  if (!outcome.ok) {
    console.error("Product copy failed", outcome.error);
    return { result: "error", errorType: outcome.error.slice(0, 200) };
  }
  return { result: "success", toolOutput: wrapOutput(outcome.items) };
}
