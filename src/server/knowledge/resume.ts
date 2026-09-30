import "server-only";
import { prisma } from "@/lib/db";
import { enqueue } from "./queue";

/** The user reconnected Google: sources that were waiting on it start syncing again. */
export async function resumeKnowledgeSources(accountId: string) {
  const sources = await prisma.knowledgeSource.findMany({
    where: { accountId, status: "NEEDS_RECONNECT" },
    select: { id: true },
  });
  for (const { id } of sources) {
    await prisma.knowledgeSource.update({
      where: { id },
      data: { status: "ACTIVE", lastError: null },
    });
    await enqueue("SYNC_SOURCE", id);
  }
}
