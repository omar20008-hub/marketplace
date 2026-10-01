import { NextResponse } from "next/server";
import { env } from "@/lib/env";
import { knowledgeAvailable } from "@/server/knowledge/availability";
import { recordTick } from "@/server/knowledge/heartbeat";
import { enqueueDueSyncs, runKnowledgeJobs } from "@/server/knowledge/worker";

/**
 * Runs the indexing queue for a while. The worker process (`npm run worker`) is
 * the normal way to drain it; this is for a deployment without one, called by the
 * same outside clock as the scheduler heartbeat, with the same token.
 */
export async function POST(request: Request) {
  const token = request.headers.get("x-schedule-token");
  if (!env.scheduleToken || token !== env.scheduleToken) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  // The clock is running, whether or not there is anything to do with it.
  await recordTick();

  if (!(await knowledgeAvailable())) {
    return NextResponse.json({ ok: true, available: false });
  }

  const queued = await enqueueDueSyncs();
  return NextResponse.json({ ok: true, available: true, queued, ...(await runKnowledgeJobs()) });
}

export const GET = POST;

export const dynamic = "force-dynamic";
export const maxDuration = 60;
