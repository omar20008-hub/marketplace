import { NextResponse } from "next/server";
import { env } from "@/lib/env";
import { expireFacebookAccounts } from "@/server/facebook-account";
import { keepGoogleAccountsAlive } from "@/server/google-account";

/**
 * Renews Google connections nobody has used in a week, so none drifts toward the
 * six months of disuse after which Google drops a refresh token, and marks the
 * Facebook connections whose token has run out. Called by the
 * same outside clock as the scheduler heartbeat — daily is plenty — with the
 * same token, and refused without it.
 */
export async function POST(request: Request) {
  const token = request.headers.get("x-schedule-token");
  if (!env.scheduleToken || token !== env.scheduleToken) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const google = await keepGoogleAccountsAlive();
  // Facebook tokens cannot be renewed; the ones that ran out are marked, so the
  // person sees "Reconnect" rather than a post that fails with Facebook's message.
  const facebookExpired = await expireFacebookAccounts();
  return NextResponse.json({ ok: true, ...google, facebookExpired });
}

export const GET = POST;

export const dynamic = "force-dynamic";
