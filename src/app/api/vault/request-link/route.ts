import { NextResponse } from "next/server";
import { hit } from "@/lib/rate-limit";
import { appUrl } from "@/lib/public-origin";
import { bearerToken, userForAgentKey } from "@/server/agent-keys";
import { normalizeSiteUrl, requestSiteLoginLink } from "@/server/site-logins";

/**
 * Called by a person's own personal assistant when a site needs a login the
 * platform does not hold yet. Returns a one-time link the person opens to type
 * the login in.
 *
 * The person is the one the Authorization key belongs to. A user id in the body
 * is not read, so a key can only ask for links for its own owner.
 *
 * Body: { "siteUrl": "https://..." }.
 */
export async function POST(request: Request) {
  const userId = await userForAgentKey(bearerToken(request));
  if (!userId) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const body = (await request.json().catch(() => null)) as { siteUrl?: unknown } | null;
  if (typeof body?.siteUrl !== "string") {
    return NextResponse.json({ error: "Bad request" }, { status: 400 });
  }
  const ref = normalizeSiteUrl(body.siteUrl);
  if ("error" in ref) return NextResponse.json({ error: ref.error }, { status: 400 });

  const limit = hit(`vault-link:${userId}`, { limit: 10, windowMs: 60 * 60_000 });
  if (!limit.ok) return NextResponse.json({ error: "rate_limited" }, { status: 429 });

  const { token, expiresAt } = await requestSiteLoginLink({ userId, siteUrl: ref.siteUrl });
  return NextResponse.json({
    url: appUrl(`/logins/add/${token}`, {}, request),
    expiresAt: expiresAt.toISOString(),
    host: ref.host,
  });
}

export const dynamic = "force-dynamic";
