import { NextResponse } from "next/server";
import { env } from "@/lib/env";
import { runDueSchedules } from "@/server/scheduler";

/**
 * The scheduler's heartbeat.
 *
 * The platform does not run a clock of its own. Next has no durable timer — an
 * interval inside the server dies with the process, and runs twice the moment
 * there are two instances behind a load balancer — so something outside calls
 * this, once a minute. A cron daemon, a platform cron, a GitHub Action or an
 * n8n Schedule Trigger all do equally well; the endpoint does not care which,
 * which is the point.
 *
 * Every schedule's owner is read from its own row, so this needs no session. It
 * does need the shared token, without which anyone who found the URL could
 * spend other people's plan limits at whatever rate they liked.
 *
 * Calling it more often than the schedules need is harmless: a schedule that is
 * not due is not touched.
 */

export async function POST(request: Request) {
  const token = request.headers.get("x-schedule-token");
  if (!env.scheduleToken || token !== env.scheduleToken) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const summary = await runDueSchedules();
  return NextResponse.json({ ok: true, ...summary });
}

/**
 * Some schedulers can only issue a GET. It does the same thing, and is still
 * behind the token — which is also why this route must never be cached.
 */
export const GET = POST;

export const dynamic = "force-dynamic";
