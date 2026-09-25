"use server";

import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/db";
import { requireUser } from "@/lib/auth";
import { askOrchestrator } from "./run-engine";

/**
 * A follow-up inside an existing thread. The conversation itself lives in
 * MP · Orchestrator, which builds its tool catalogue from this user's
 * installations — so sessionId must be the real authenticated id, not the
 * thread id and not anything the browser supplied.
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

  const output = await askOrchestrator(user.id, body);

  await prisma.message.create({
    data: { threadId: thread.id, role: "ASSISTANT", body: output },
  });

  await prisma.thread.update({
    where: { id: thread.id },
    data: { updatedAt: new Date() },
  });

  revalidatePath(`/tasks/${thread.id}`);
}
