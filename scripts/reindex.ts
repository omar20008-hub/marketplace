import "dotenv/config";

/**
 * Queues files to be read and embedded again.
 *
 *   npm run reindex                 files embedded by a model other than the current one
 *   npm run reindex -- --all        every ready or failed file
 *   npm run reindex -- --source ID  limit either to one source
 *
 * It only queues; the worker (or the tick endpoint) does the work. Until a stale
 * file is redone, search treats it as still being processed rather than
 * comparing vectors from two different models.
 */

const args = process.argv.slice(2);
const all = args.includes("--all");
const at = args.indexOf("--source");
const sourceId = at >= 0 ? args[at + 1] : undefined;

async function main() {
  const { reindexFiles } = await import("@/server/knowledge/reindex");
  const { prisma } = await import("@/lib/db");
  const { queued } = await reindexFiles({ stale: !all, sourceId });
  console.log(`Queued ${queued} file${queued === 1 ? "" : "s"} for re-indexing.`);
  await prisma.$disconnect();
}

void main();
