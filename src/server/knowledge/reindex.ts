import "server-only";
import { prisma } from "@/lib/db";
import { embeddingTag } from "@/lib/embeddings";
import { enqueue } from "./queue";

/**
 * Reads files again. For when the embedding model changes — old vectors cannot
 * be compared with new ones — or when something went wrong at scale and a clean
 * pass is wanted. Search ignores a file embedded by another model, so `stale`
 * (the default) is exactly the set that is invisible until it is redone.
 */
export async function reindexFiles({
  stale = true,
  sourceId,
}: { stale?: boolean; sourceId?: string } = {}): Promise<{ queued: number }> {
  const files = await prisma.knowledgeFile.findMany({
    where: {
      status: { in: ["READY", "FAILED"] },
      ...(sourceId ? { sourceId } : {}),
      ...(stale ? { embeddingModel: { not: null, notIn: [embeddingTag()] } } : {}),
    },
    select: { id: true },
  });

  for (const { id } of files) {
    await prisma.knowledgeFile.update({ where: { id }, data: { status: "PENDING", error: null } });
    await enqueue("INDEX_FILE", id);
  }
  return { queued: files.length };
}
