import { NextResponse } from "next/server";
import { env } from "@/lib/env";
import { runLifecycleSweep } from "@/server/lifecycle-sweep";

/**
 * The daily lifecycle check: switches off copies whose product was put on security
 * hold or deleted, and lists the ones disabled by repeated failures. Called by the
 * same outside clock as the other daily jobs (03:00 UTC, as the n8n sweep ran),
 * with SCHEDULE_TOKEN in x-schedule-token, and refused without it.
 */
export async function POST(request: Request) {
  const token = request.headers.get("x-schedule-token");
  if (!env.scheduleToken || token !== env.scheduleToken) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { checked, disabled, reported, n8nRefused } = await runLifecycleSweep();
  return NextResponse.json({
    ok: true,
    checked,
    disabled: disabled.length,
    reported: reported.length,
    n8nRefused: n8nRefused.length,
  });
}

export const dynamic = "force-dynamic";
