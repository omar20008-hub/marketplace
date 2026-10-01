import { NextResponse } from "next/server";
import { env } from "@/lib/env";
import { googleMissingConfig } from "@/lib/google-oauth";
import { knowledgeAvailable } from "@/server/knowledge/availability";
import { isStalled, queueHealth } from "@/server/knowledge/heartbeat";

/**
 * Is knowledge search set up and being run? For whoever operates the deployment,
 * and the first thing to check when files sit on "Syncing":
 *
 *   curl -s https://<domain>/api/knowledge/status -H "x-schedule-token: $SCHEDULE_TOKEN"
 *
 * Same token as the tick endpoint, and refused without it. It reports setting
 * *names* that are missing and counts and ages — never a value.
 */
export async function GET(request: Request) {
  const token = request.headers.get("x-schedule-token");
  if (!env.scheduleToken || token !== env.scheduleToken) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const [available, health] = await Promise.all([knowledgeAvailable(), queueHealth()]);
  const missing = googleMissingConfig();

  return NextResponse.json({
    ok: available && missing.length === 0 && !isStalled(health),
    database: { pgvector: available },
    google: { configured: missing.length === 0, missing },
    tick: { lastAgeSeconds: health.lastTickAgeSeconds },
    queue: { waitingTooLong: health.waitingTooLong, stalled: isStalled(health) },
  });
}

export const dynamic = "force-dynamic";
