import "server-only";
import { prisma } from "@/lib/db";

/**
 * What a plan allows of knowledge indexing. Counted per user, across every
 * installation: the cost is in reading and embedding, and that is the user's.
 * Files that cost nothing — skipped types, removed ones — are not counted, so a
 * folder full of images does not eat the allowance.
 */

const COUNTED = ["PENDING", "INDEXING", "READY", "FAILED"] as const;

export async function knowledgeUsage(userId: string) {
  const [user, sources, files] = await Promise.all([
    prisma.user.findUniqueOrThrow({
      where: { id: userId },
      select: { plan: { select: { name: true, knowledgeSources: true, knowledgeFiles: true } } },
    }),
    prisma.knowledgeSource.count({ where: { userId } }),
    prisma.knowledgeFile.count({
      where: { source: { userId }, status: { in: [...COUNTED] } },
    }),
  ]);
  return {
    planName: user.plan.name,
    maxSources: user.plan.knowledgeSources,
    maxFiles: user.plan.knowledgeFiles,
    sources,
    files,
  };
}
