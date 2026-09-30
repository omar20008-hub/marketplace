import "dotenv/config";

/**
 * The knowledge indexing worker: a long-running process that drains the job queue
 * — syncing watched folders, reading files, embedding them. Run it beside the web
 * app (`npm run worker`), as a second service in production. It needs the same
 * environment as the app (DATABASE_URL, SECRETS_KEY, the GOOGLE_* and embedding
 * settings) and nothing else; it does not talk to the web app.
 *
 * It imports the app's own modules, which are marked "server-only". Node's
 * `react-server` condition (see the npm script) resolves that marker to an empty
 * module, the same way Next does for server code.
 */

const IDLE_MS = Number(process.env.WORKER_IDLE_MS ?? 5_000);
let stopping = false;
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    stopping = true;
  });
}

const stamp = () => new Date().toISOString().slice(11, 19);
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function main() {
  const { knowledgeAvailable } = await import("@/server/knowledge/availability");
  const { enqueueDueSyncs, runKnowledgeJobs } = await import("@/server/knowledge/worker");

  console.log(`${stamp()}  knowledge worker started`);
  let warned = false;
  while (!stopping) {
    try {
      if (!(await knowledgeAvailable())) {
        if (!warned) console.warn(`${stamp()}  pgvector is not available on this database; idle`);
        warned = true;
        await sleep(30_000);
        continue;
      }
      warned = false;
      const queued = await enqueueDueSyncs();
      const summary = await runKnowledgeJobs({ budgetMs: 30_000 });
      if (queued || summary.ran || summary.failed) {
        console.log(
          `${stamp()}  queued ${queued} sync(s); ran ${summary.ran}, failed ${summary.failed}, gave up ${summary.gaveUp}`,
        );
      }
      if (summary.ran + summary.failed === 0) await sleep(IDLE_MS);
    } catch (error) {
      console.error(`${stamp()}  worker error:`, error);
      await sleep(IDLE_MS);
    }
  }
  console.log(`${stamp()}  knowledge worker stopped`);
  process.exit(0);
}

void main();
