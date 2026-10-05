import "server-only";
import { after } from "next/server";
import { prisma } from "@/lib/db";
import { askOrchestrator } from "./run-engine";
import { handleMemoryCommand, learnAfterResponse, withMemories } from "./memory";

/**
 * Produces the assistant's reply to a message already stored in a thread. It runs
 * after the response has gone out (see replyInBackground), so the person sees their
 * own message and a "Thinking…" line at once instead of a frozen form; the thread
 * page refreshes itself until the reply lands.
 *
 * "Remember that …" is answered here; everything else goes to the Orchestrator
 * with what the person has asked to be remembered in front of it. The stored
 * user message stays exactly what they wrote.
 */
export async function answerThread(userId: string, threadId: string, text: string, chatInput = text) {
  let output: string;
  try {
    const command = await handleMemoryCommand(userId, text);
    output =
      command ?? (await askOrchestrator(userId, await withMemories(userId, chatInput), threadId));
    if (command === null) learnAfterResponse(userId, text);
  } catch (error) {
    console.error("Reply failed", error instanceof Error ? error.name : "error");
    output = "Something went wrong reaching the assistant. Please try again in a moment.";
  }
  await prisma.message.create({ data: { threadId, role: "ASSISTANT", body: output } });
  await prisma.thread.update({ where: { id: threadId }, data: { updatedAt: new Date() } });
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
