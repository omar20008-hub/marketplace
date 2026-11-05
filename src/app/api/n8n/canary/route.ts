import { NextResponse } from "next/server";
import { env } from "@/lib/env";
import { runN8nCanary } from "@/server/n8n-canary";

/**
 * The hourly check on the n8n connection (see n8n-canary.ts). Called by the same
 * outside clock as the other jobs with SCHEDULE_TOKEN in x-schedule-token, and
 * refused without it. Run it every hour: a refused key then pauses installs for at
 * most an hour before the catch-up runs.
 */
export async function POST(request: Request) {
  const token = request.headers.get("x-schedule-token");
  if (!env.scheduleToken || token !== env.scheduleToken) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const status = await runN8nCanary();
  return NextResponse.json({ ok: true, state: status.state, caughtUp: status.caughtUp });
}

export const dynamic = "force-dynamic";
