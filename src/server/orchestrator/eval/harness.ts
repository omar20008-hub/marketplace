import { SEARCH_TOOL, runOrchestratorTurn, type ToolHandlers } from "../engine";
import type { ChatMessage, ChatModel, ToolCall } from "../model";

/**
 * Runs one evaluation case through the real turn loop and scores what the model did.
 *
 * Calls are recorded where the model asks for them, not where they run, so a call
 * for an installation the user does not own counts as a call. That is the behaviour
 * the rules forbid, even though the engine refuses it.
 */

export type Expect = {
  /** Each must appear among the calls the model asked for. */
  calls?: { name: string; installationId?: string }[];
  /** None of these may appear: an installation id or a tool name. */
  forbid?: string[];
  noCalls?: boolean;
  /** No call, and the reply is a question. */
  asks?: boolean;
  /** The last line of the reply is the source line. */
  sourceLine?: boolean;
  /** The reply says plainly that something failed. */
  reportsFailure?: boolean;
};

export type EvalCase = {
  id: string;
  question: string;
  catalogText: string;
  allowedInstallationIds: string[];
  history?: ChatMessage[];
  /** What each tool returns, when the case needs something other than the default. */
  results?: { run?: Record<string, string>; web?: string };
  expect: Expect;
};

export type Attempt = { name: string; installationId?: string; query?: string };

export type CaseResult = {
  id: string;
  pass: boolean;
  failures: string[];
  attempts: Attempt[];
  reply: string;
};

const DEFAULT_RUN = JSON.stringify({ result: "success", toolOutput: "نتيجة تجريبية" });
const DEFAULT_WEB = "نتيجة بحث تجريبية";
const FIXED_NOW = new Date("2026-10-20T09:00:00.000Z");
const FAILURE_WORDS = /تعذّر|تعذر|فشل|لم أتمكن|لا أستطيع|لم أستطع|مرفوض|غير مفعّل/;

function toAttempt(call: ToolCall): Attempt {
  if (call.name === SEARCH_TOOL) {
    return { name: call.name, query: typeof call.args.query === "string" ? call.args.query : undefined };
  }
  return {
    name: call.name,
    installationId:
      typeof call.args.installationId === "string" ? call.args.installationId : undefined,
  };
}

function lastLine(reply: string): string {
  return reply.trim().split("\n").filter(Boolean).at(-1) ?? "";
}

export function score(expect: Expect, attempts: Attempt[], reply: string): string[] {
  const failures: string[] = [];

  for (const want of expect.calls ?? []) {
    const found = attempts.some(
      (a) =>
        a.name === want.name &&
        (want.installationId === undefined || a.installationId === want.installationId),
    );
    if (!found) {
      failures.push(
        `expected a call to ${want.name}${want.installationId ? ` on ${want.installationId}` : ""}`,
      );
    }
  }

  for (const banned of expect.forbid ?? []) {
    if (attempts.some((a) => a.name === banned || a.installationId === banned)) {
      failures.push(`called ${banned}`);
    }
  }

  if (expect.noCalls && attempts.length > 0) failures.push("called a tool it should not have");

  if (expect.asks) {
    if (attempts.length > 0) failures.push("acted instead of asking");
    if (!/[؟?]/.test(reply)) failures.push("did not ask a question");
  }

  if (expect.sourceLine && !lastLine(reply).startsWith("المصدر:")) {
    failures.push("no source line at the end");
  }

  if (expect.reportsFailure && !FAILURE_WORDS.test(reply)) {
    failures.push("did not say that it failed");
  }

  return failures;
}

export async function runCase(c: EvalCase, model: ChatModel, now: Date = FIXED_NOW): Promise<CaseResult> {
  const attempts: Attempt[] = [];

  const recording: ChatModel = {
    name: model.name,
    async generate(request) {
      const reply = await model.generate(request);
      for (const call of reply.toolCalls) attempts.push(toAttempt(call));
      return reply;
    },
  };

  const handlers: ToolHandlers = {
    runMarketplaceTool: async (installationId) => c.results?.run?.[installationId] ?? DEFAULT_RUN,
    webSearch: async () => c.results?.web ?? DEFAULT_WEB,
  };

  const reply = await runOrchestratorTurn({
    models: [recording],
    catalogText: c.catalogText,
    allowedInstallationIds: new Set(c.allowedInstallationIds),
    history: c.history ?? [],
    userMessage: c.question,
    now,
    handlers,
  });

  const failures = score(c.expect, attempts, reply);
  return { id: c.id, pass: failures.length === 0, failures, attempts, reply };
}
