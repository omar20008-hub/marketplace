import { NextResponse } from "next/server";
import { hit } from "@/lib/rate-limit";
import { installationForKey } from "@/server/knowledge/keys";
import { activateAdCampaign } from "@/server/ads/activate";

/**
 * Switches a paused campaign on, once the person has confirmed the ceiling shown
 * in its review. The confirmed amount must match the one recomputed now, so a
 * campaign changed after review is not started (see server/ads/activate.ts).
 */

const unauthorized = () => NextResponse.json({ error: "Unauthorized" }, { status: 401 });

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const installation = await installationForKey(request.headers.get("authorization"));
  if (!installation) return unauthorized();

  const limiter = hit(`ads-activate:${installation.id}`, { limit: 10, windowMs: 60_000 });
  if (!limiter.ok) {
    return NextResponse.json(
      { error: "Too many requests" },
      { status: 429, headers: { "retry-after": String(limiter.retryAfterSeconds) } },
    );
  }

  const { id } = await params;
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Body must be JSON" }, { status: 400 });
  }
  const confirmed = (body as { confirmedMaxTotalCents?: unknown } | null)?.confirmedMaxTotalCents;
  if (typeof confirmed !== "number" || !Number.isInteger(confirmed) || confirmed < 0) {
    return NextResponse.json({ error: "confirmedMaxTotalCents must be a whole number of minor units" }, { status: 400 });
  }

  const result = await activateAdCampaign(installation.userId, id, confirmed);
  if (!result.ok) return NextResponse.json({ error: "Not switched on", errors: result.errors }, { status: 409 });
  return NextResponse.json({ id, status: result.status });
}

export const dynamic = "force-dynamic";
