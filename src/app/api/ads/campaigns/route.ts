import { NextResponse } from "next/server";
import { hit } from "@/lib/rate-limit";
import { installationForKey } from "@/server/knowledge/keys";
import { createAdCampaign } from "@/server/ads/campaigns";

/**
 * Creates an ads campaign for the installation's owner, left PAUSED in Meta, and
 * returns the review the person must confirm before it is switched on. Called by
 * the installed Ads workflow with the installation's own kb_ key, like /api/posts.
 */

const unauthorized = () => NextResponse.json({ error: "Unauthorized" }, { status: 401 });

export async function POST(request: Request) {
  const installation = await installationForKey(request.headers.get("authorization"));
  if (!installation) return unauthorized();

  const limiter = hit(`ads:${installation.id}`, { limit: 20, windowMs: 60_000 });
  if (!limiter.ok) {
    return NextResponse.json(
      { error: "Too many requests" },
      { status: 429, headers: { "retry-after": String(limiter.retryAfterSeconds) } },
    );
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Body must be JSON" }, { status: 400 });
  }
  if (typeof body !== "object" || body === null) {
    return NextResponse.json({ error: "Body must be an object" }, { status: 400 });
  }

  const raw = body as Record<string, unknown>;
  // startsAt and endsAt arrive as ISO strings; the validator turns them into dates.
  const result = await createAdCampaign(installation.userId, raw);
  if (!result.ok) return NextResponse.json({ error: "Invalid campaign", errors: result.errors }, { status: 400 });

  return NextResponse.json(
    { id: result.campaignId, status: result.status, review: result.review },
    { status: 201 },
  );
}

export const dynamic = "force-dynamic";
