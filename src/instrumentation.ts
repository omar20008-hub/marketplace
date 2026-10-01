import { parseTickInterval } from "./lib/tick-interval";

/**
 * Runs once when a Next.js server instance starts (see
 * node_modules/next/dist/docs/01-app/02-guides/instrumentation.md). It must return
 * before the server takes requests, so it only *starts* things.
 *
 * Today that is the knowledge tick scheduler, which is off unless
 * KNOWLEDGE_TICK_INTERVAL_SECONDS is set. Two rules keep this file from ever being
 * the reason a server does not come up:
 *  - it imports nothing heavy unless the scheduler is wanted. The scheduler pulls
 *    in lib/env.ts, whose production guards throw on a weak or example secret;
 *    that must stay a failure of the request that needs it, as it always was, not
 *    of every boot — including one that never asked for a scheduler.
 *  - whatever starting it throws is logged and swallowed.
 * The import is also dynamic and inside the Node.js branch: this file is evaluated
 * for the Edge runtime too, which has no database driver.
 */
export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  if (parseTickInterval(process.env.KNOWLEDGE_TICK_INTERVAL_SECONDS) === 0) return;

  try {
    const { startKnowledgeScheduler } = await import("./server/knowledge/scheduler");
    startKnowledgeScheduler();
  } catch (error) {
    // The name only: a configuration error's message can quote the setting.
    console.error(
      `Knowledge scheduler did not start: ${error instanceof Error ? error.name : "unknown error"}`,
    );
  }
}
