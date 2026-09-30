import { NextResponse } from "next/server";
import { env } from "@/lib/env";
import { keepGoogleAccountsAlive } from "@/server/google-account";

/**
 * Renews Google connections nobody has used in a week, so none drifts toward the
 * six months of disuse after which Google drops a refresh token. Called by the
 * same outside clock as the scheduler heartbeat — daily is plenty — with the
 * same token, and refused without it.
 */
export async function POST(request: Request) {
  const token = request.headers.get("x-schedule-token");
  if (!env.scheduleToken || token !== env.scheduleToken) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  return NextResponse.json({ ok: true, ...(await keepGoogleAccountsAlive()) });
}

export const GET = POST;

export const dynamic = "force-dynamic";
