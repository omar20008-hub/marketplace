import "server-only";
import { prisma } from "@/lib/db";

/**
 * Whether this database can store embeddings. The migration adds the column only
 * when pgvector is installed, so a deploy onto a database without it still
 * succeeds — and everything that would write or search vectors asks here first.
 */
export async function knowledgeAvailable(): Promise<boolean> {
  const rows = await prisma.$queryRaw<{ ok: boolean }[]>`
    SELECT EXISTS (
      SELECT 1 FROM information_schema.columns
      WHERE table_name = 'KnowledgeChunk' AND column_name = 'embedding'
    ) AS ok`;
  return rows[0]?.ok === true;
}
