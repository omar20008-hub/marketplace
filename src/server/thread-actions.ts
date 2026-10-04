"use server";

import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/db";
import { requireUser } from "@/lib/auth";
import { askOrchestrator } from "./run-engine";
import { handleMemoryCommand, learnAfterResponse, withMemories } from "./memory";

/**
 * A follow-up inside an existing thread. The conversation itself lives in
 * MP · Orchestrator, which builds its tool catalogue from this user's
 * installations — so the user part of its sessionId must be the real
 * authenticated id, not anything the browser supplied. The thread id (checked
 * above to belong to this user) is appended so each thread has its own memory.
 */
export async function followUp(formData: FormData) {
  const user = await requireUser();
  const threadId = String(formData.get("threadId") ?? "");
  const body = String(formData.get("message") ?? "").trim();
  if (!body) return;

  const thread = await prisma.thread.findFirst({
    where: { id: threadId, userId: user.id },
    select: { id: true },
  });
  if (!thread) return;

  await prisma.message.create({
    data: { threadId: thread.id, role: "USER", body },
  });

  // "Remember that …" is answered here; everything else goes to the Orchestrator
  // with what the person has asked to be remembered in front of it. The stored
  // message stays exactly what they wrote.
  const command = await handleMemoryCommand(user.id, body);
  const output =
    command ??
    (await askOrchestrator(user.id, await withMemories(user.id, body), thread.id));
  if (command === null) learnAfterResponse(user.id, body);

  await prisma.message.create({
    data: { threadId: thread.id, role: "ASSISTANT", body: output },
  });

  await prisma.thread.update({
    where: { id: thread.id },
    data: { updatedAt: new Date() },
  });

  revalidatePath(`/tasks/${thread.id}`);
}
