import { prisma } from "@/lib/db";
import type { ChatMessage } from "./model";

/**
 * What the Orchestrator remembers of a thread: the messages before the one being
 * answered, read from the thread the platform already keeps. Nothing is stored
 * twice, and a thread that is not this user's gives no history at all.
 *
 * Only the person's messages and the final replies are kept, as the n8n buffer
 * kept them. Tool steps inside one turn were never part of the memory.
 */

export const MEMORY_WINDOW = 10;

export async function recentTurns({
  userId,
  threadId,
  beforeMessageId,
}: {
  userId: string;
  threadId: string;
  beforeMessageId: string;
}): Promise<ChatMessage[]> {
  const thread = await prisma.thread.findFirst({
    where: { id: threadId, userId },
    select: { id: true },
  });
  if (!thread) return [];

  const anchor = await prisma.message.findFirst({
    where: { id: beforeMessageId, threadId },
    select: { createdAt: true },
  });
  if (!anchor) return [];

  const rows = await prisma.message.findMany({
    where: { threadId, createdAt: { lt: anchor.createdAt } },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    take: MEMORY_WINDOW,
    select: { role: true, body: true },
  });

  return rows.reverse().map((row): ChatMessage =>
    row.role === "USER"
      ? { role: "user", content: row.body }
      : { role: "assistant", content: row.body, toolCalls: [] },
  );
}
