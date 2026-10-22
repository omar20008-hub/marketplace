import "server-only";
import { prisma } from "@/lib/db";
import { env } from "@/lib/env";
import { askOrchestrator } from "@/server/run-engine";
import { renderCatalog, toolCatalog } from "./catalog";
import { runOrchestratorTurn, type ToolHandlers } from "./engine";
import { databaseConfirmations } from "./confirmations-store";
import { createGeminiModel } from "./gemini";
import type { ChatModel } from "./model";
import { recentTurns } from "./memory";
import { runInstalledProduct } from "./runtimes/product";
import { createWebSearch } from "./runtimes/web";
import { formatHistory, searchConversation } from "../conversation-memory";

/**
 * Answers one chat message, with whichever Orchestrator the environment selects.
 * "n8n" keeps the MP · Orchestrator workflow in charge. "platform" runs the turn
 * here, and the workflows it calls are still run through n8n.
 *
 * Failures never reach the caller: whoever sends a message gets one fixed line, and
 * the cause goes to the server log. That matches askOrchestrator().
 */

const GENERIC_REPLY = "Something went wrong reaching the assistant. Please try again in a moment.";

function defaultModels(): ChatModel[] {
  const { geminiApiKey, model, fallbackModel } = env.orchestrator;
  return [
    createGeminiModel({ apiKey: geminiApiKey, model }),
    createGeminiModel({ apiKey: geminiApiKey, model: fallbackModel }),
  ];
}

export async function answerOnPlatform({
  userId,
  chatInput,
  threadId,
  currentMessageId,
  models = defaultModels(),
}: {
  userId: string;
  chatInput: string;
  threadId?: string;
  /** The stored message being answered, so its history is the messages before it. */
  currentMessageId?: string;
  models?: ChatModel[];
}): Promise<string> {
  try {
    const user = await prisma.user.findUnique({ where: { id: userId }, include: { plan: true } });
    const entries = user ? await toolCatalog(userId) : [];
    const history =
      threadId && currentMessageId
        ? await recentTurns({ userId, threadId, beforeMessageId: currentMessageId })
        : [];

    const handlers: ToolHandlers = {
      runMarketplaceTool: async (installationId, args) =>
        user
          ? runInstalledProduct({ user, installationId, args, threadId })
          : JSON.stringify({ result: "denied", reason: "installation_not_found" }),
      webSearch: createWebSearch(),
      ...(user
        ? { searchConversation: async (query: string) => formatHistory(await searchConversation(userId, query)) }
        : {}),
    };

    return await runOrchestratorTurn({
      models,
      catalogText: renderCatalog(entries),
      actionTypes: new Map(entries.map((entry) => [entry.installationId, entry.actionType])),
      confirmations: databaseConfirmations({ userId, threadId, currentMessageId, userMessage: chatInput }),
      history,
      userMessage: chatInput,
      now: new Date(),
      handlers,
    });
  } catch (error) {
    console.error("Orchestrator (platform) failed", error);
    return GENERIC_REPLY;
  }
}

export async function answerMessage({
  userId,
  chatInput,
  threadId,
  currentMessageId,
}: {
  userId: string;
  chatInput: string;
  threadId?: string;
  currentMessageId?: string;
}): Promise<string> {
  if (env.orchestrator.driver === "platform") {
    return answerOnPlatform({ userId, chatInput, threadId, currentMessageId });
  }
  return askOrchestrator(userId, chatInput, threadId);
}
