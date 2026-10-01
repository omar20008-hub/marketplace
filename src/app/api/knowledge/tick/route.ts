import { NextResponse } from "next/server";
import { env } from "@/lib/env";
import { tickKnowledge } from "@/server/knowledge/worker";

/**
 * Runs the indexing queue for a while, for whoever prefers an outside clock (a
 * cron, n8n): the same pass the in-process scheduler runs
 * (KNOWLEDGE_TICK_INTERVAL_SECONDS) and the worker process does, protected by the
 * same token as the scheduler heartbeat.
 */
export async function POST(request: Request) {
  const token = request.headers.get("x-schedule-token");
  if (!env.scheduleToken || token !== env.scheduleToken) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const result = await tickKnowledge();
  if (!result.available) return NextResponse.json({ ok: true, available: false });
  return NextResponse.json({ ok: true, ...result });
}

export const GET = POST;

export const dynamic = "force-dynamic";
export const maxDuration = 60;
