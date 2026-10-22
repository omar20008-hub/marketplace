"use server";

import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/db";
import { requireUser } from "@/lib/auth";
import { answerThread, replyInBackground } from "./thread-reply";
import { describeAttachments, resolveAttachments } from "./media";
import { ATTACHED_ONLY, describeFiles, resolveUserFiles } from "./files/user-files";

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
  // A file sent without a word still deserves an answer about the file.
  const body =
    String(formData.get("message") ?? "").trim() ||
    (formData.getAll("file").length + formData.getAll("attachment").length > 0 ? ATTACHED_ONLY : "");
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
  // Files are this user's own saved files, their text already read (see /api/files).
  const files = describeFiles(await resolveUserFiles(user.id, formData.getAll("file").map(String)));
  const shown = [body, attachments.shown, files.shown].filter(Boolean).join("\n\n");
  const chatInput = [body, attachments.forAssistant, files.forAssistant].filter(Boolean).join("\n\n");

  const message = await prisma.message.create({
    data: { threadId: thread.id, role: "USER", body: shown },
  });

  revalidatePath(`/tasks/${thread.id}`);
  // The memory commands read what was typed, not the attachment note.
  await replyInBackground(() =>
    answerThread(user.id, thread.id, body, message.id, chatInput),
  );
}
