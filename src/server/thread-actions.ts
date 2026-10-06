"use server";

import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/db";
import { requireUser } from "@/lib/auth";
import { answerThread, replyInBackground } from "./thread-reply";
import { describeAttachments, resolveAttachments } from "./media";

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

  // Only links to this user's own live uploads survive (see resolveAttachments).
  const attachments = describeAttachments(
    await resolveAttachments(user.id, formData.getAll("attachment").map(String)),
  );
  const shown = attachments.shown ? `${body}\n\n${attachments.shown}` : body;
  const chatInput = attachments.forAssistant ? `${body}\n\n${attachments.forAssistant}` : body;

  await prisma.message.create({
    data: { threadId: thread.id, role: "USER", body: shown },
  });

  revalidatePath(`/tasks/${thread.id}`);
  // The memory commands read what was typed, not the attachment note.
  await replyInBackground(() => answerThread(user.id, thread.id, body, chatInput));
}
