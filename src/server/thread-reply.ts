import "server-only";
import { after } from "next/server";
import { prisma } from "@/lib/db";
import { answerMessage } from "./orchestrator/assistant";
import { handleMemoryCommand, learnAfterResponse, withMemories } from "./memory";
import { withFiles } from "./files/user-files";
import { withConversation } from "./conversation";
import { rememberThread } from "./conversation-memory";
import { env } from "@/lib/env";

/**
 * Produces the assistant's reply to a message already stored in a thread. It runs
 * after the response has gone out (see replyInBackground), so the person sees their
 * own message and a "Thinking…" line at once instead of a frozen form; the thread
 * page refreshes itself until the reply lands.
 *
 * "Remember that …" is answered here; everything else goes to the Orchestrator
 * with what the person has asked to be remembered, and what of their saved files
 * matches the message, in front of it. The stored
 * user message stays exactly what they wrote.
 */
export async function answerThread(
  userId: string,
  threadId: string,
  text: string,
  currentMessageId: string,
  chatInput = text,
) {
  let output: string;
  try {
    const command = await handleMemoryCommand(userId, text);
    output =
      command ??
      (await answerMessage({
        userId,
        chatInput: await withRecentTurns(
          userId,
          threadId,
          currentMessageId,
          await withMemories(userId, await withFiles(userId, text, chatInput)),
        ),
        threadId,
        currentMessageId,
      }));
    if (command === null) learnAfterResponse(userId, text);
  } catch (error) {
    console.error("Reply failed", error instanceof Error ? error.name : "error");
    output = "Something went wrong reaching the assistant. Please try again in a moment.";
  }
  await prisma.message.create({ data: { threadId, role: "ASSISTANT", body: output } });
  await prisma.thread.update({ where: { id: threadId }, data: { updatedAt: new Date() } });
  // Already after the response: index the turn and bring the summary up to date.
  await rememberThread(userId, threadId);
}

/**
 * Runs the work once the response is sent. Outside a request (a test, a script)
 * there is nothing to defer past, so it runs inline.
 */
export async function replyInBackground(work: () => Promise<void>) {
  try {
    after(work);
  } catch {
    await work();
  }
}

/**
 * The thread's recent turns in front of the message when n8n answers it. The n8n
 * Orchestrator keeps its own memory, but a tool it hands the message to (the
 * personal assistant) does not, and would otherwise start from nothing. The
 * in-app Orchestrator reads the recent turns itself, so it is given only the
 * summary of the older ones.
 */
async function withRecentTurns(userId: string, threadId: string, currentMessageId: string, chatInput: string) {
  if (env.orchestrator.driver === "platform") return withConversation(userId, threadId, chatInput, { summaryOnly: true });
  return withConversation(userId, threadId, chatInput, { before: currentMessageId });
}
