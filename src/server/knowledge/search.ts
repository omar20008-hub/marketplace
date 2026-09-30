import "server-only";
import { prisma } from "@/lib/db";
import { embedTexts, toVectorLiteral } from "@/lib/embeddings";

/**
 * Passages from one installation's own sources that best answer a question.
 * Scoped by installation id in the query itself — there is no code path that
 * searches "everything", so a bug elsewhere cannot widen what a key can see.
 */

export const DEFAULT_LIMIT = 6;
export const MAX_LIMIT = 12;

export type Passage = {
  text: string;
  score: number;
  file: { name: string; path: string | null; url: string | null };
};

export type SearchResult = {
  passages: Passage[];
  /** What the agent needs to answer honestly when there is little to find. */
  library: {
    sources: number;
    files: { ready: number; pending: number; failed: number; unsupported: number };
    lastSyncedAt: Date | null;
    needsReconnect: boolean;
  };
  /** The passages laid out with numbered citations, ready to paste into a prompt. */
  context: string;
};

export async function searchKnowledge(
  installationId: string,
  query: string,
  limit = DEFAULT_LIMIT,
): Promise<SearchResult> {
  const k = Math.min(Math.max(Math.trunc(limit) || DEFAULT_LIMIT, 1), MAX_LIMIT);

  const sources = await prisma.knowledgeSource.findMany({
    where: { installationId, status: { not: "PAUSED" } },
    select: { id: true, status: true, lastSyncedAt: true },
  });
  const sourceIds = sources.map((s) => s.id);

  const counts = { ready: 0, pending: 0, failed: 0, unsupported: 0 };
  if (sourceIds.length > 0) {
    const grouped = await prisma.knowledgeFile.groupBy({
      by: ["status"],
      where: { sourceId: { in: sourceIds } },
      _count: true,
    });
    for (const row of grouped) {
      if (row.status === "READY") counts.ready = row._count;
      else if (row.status === "PENDING" || row.status === "INDEXING") counts.pending += row._count;
      else if (row.status === "FAILED") counts.failed = row._count;
      else if (row.status === "UNSUPPORTED") counts.unsupported = row._count;
    }
  }

  const library: SearchResult["library"] = {
    sources: sources.length,
    files: counts,
    lastSyncedAt: sources.reduce<Date | null>(
      (latest, s) => (s.lastSyncedAt && (!latest || s.lastSyncedAt > latest) ? s.lastSyncedAt : latest),
      null,
    ),
    needsReconnect: sources.some((s) => s.status === "NEEDS_RECONNECT"),
  };

  if (counts.ready === 0) return { passages: [], library, context: "" };

  const [vector] = await embedTexts([query], "query");
  const rows = await prisma.$queryRaw<
    { content: string; name: string; path: string | null; webUrl: string | null; score: number }[]
  >`
    SELECT c.content, f.name, f.path, f."webUrl",
           1 - (c.embedding <=> ${toVectorLiteral(vector)}::vector) AS score
    FROM "KnowledgeChunk" c
    JOIN "KnowledgeFile" f ON f.id = c."fileId"
    WHERE c."sourceId" = ANY(${sourceIds}::text[])
      AND f.status = 'READY'
      AND c.embedding IS NOT NULL
    ORDER BY c.embedding <=> ${toVectorLiteral(vector)}::vector
    LIMIT ${k}`;

  const passages: Passage[] = rows.map((row) => ({
    text: row.content,
    score: Number(row.score),
    file: { name: row.name, path: row.path, url: row.webUrl },
  }));

  const context = passages
    .map((p, i) => {
      const where = p.file.path ? `${p.file.path}/${p.file.name}` : p.file.name;
      return `[${i + 1}] ${where}\n${p.text}`;
    })
    .join("\n\n---\n\n");

  return { passages, library, context };
}
