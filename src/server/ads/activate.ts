import "server-only";
import { prisma } from "@/lib/db";
import { openCredential } from "@/lib/secrets";
import { FACEBOOK_CREDENTIAL } from "@/lib/facebook-oauth";
import { MetaAdsError, setObjectStatus } from "@/lib/ads/meta-ads";
import { reviewCampaign } from "@/lib/ads/review";

/**
 * Switches a paused campaign on in Meta. This is the first call that can spend
 * money, so it is guarded in three ways:
 *
 *  1. The person must confirm the exact ceiling shown on the review screen. If the
 *     campaign changed since, the confirmed number no longer matches and nothing is
 *     switched on.
 *  2. It must still be PAUSED, and must not have ended.
 *   3. The row is claimed (PAUSED → ACTIVE) so two requests cannot both switch
 *     it on, and each Meta object is switched on in turn with its result recorded.
 *
 * Money moves only in Meta, from the person's own ad account payment method.
 */

export type ActivateResult =
  | { ok: true; status: "ACTIVE" }
  | { ok: false; errors: string[] };

export async function activateAdCampaign(
  userId: string,
  campaignId: string,
  confirmedMaxTotalCents: number,
  fetcher: typeof fetch = fetch,
  now = new Date(),
): Promise<ActivateResult> {
  const row = await prisma.adCampaign.findFirst({ where: { id: campaignId, userId } });
  if (!row) return { ok: false, errors: ["That campaign was not found."] };
  if (row.status !== "PAUSED") {
    return { ok: false, errors: [`This campaign is ${row.status.toLowerCase()}, so it cannot be switched on now.`] };
  }
  if (row.endsAt.getTime() <= now.getTime()) {
    return { ok: false, errors: ["This campaign's end date has passed. Create a new campaign with future dates."] };
  }

  const review = reviewCampaign({
    name: row.name,
    objective: row.objective,
    dailyBudgetCents: row.dailyBudgetCents,
    startsAt: row.startsAt,
    endsAt: row.endsAt,
    platforms: row.platforms,
    targeting: row.targeting as { countries: string[]; ageMin: number; ageMax: number },
  });
  if (confirmedMaxTotalCents !== review.maxTotalCents) {
    return {
      ok: false,
      errors: [
        `The campaign has changed since you reviewed it. You confirmed ${confirmedMaxTotalCents}, but it now runs up to ${review.maxTotalCents}. Review it again.`,
      ],
    };
  }

  const connection = await prisma.connector.findFirst({
    where: { userId, credentialType: FACEBOOK_CREDENTIAL, status: "ACTIVE" },
  });
  if (!connection?.secretJson) {
    return { ok: false, errors: ["Connect Facebook & Instagram with ads permission first."] };
  }
  const accessToken = openCredential(connection.secretJson).accessToken;
  if (!accessToken) return { ok: false, errors: ["Your Facebook connection has no usable token. Sign in again."] };

  const claimed = await prisma.adCampaign.updateMany({
    where: { id: row.id, status: "PAUSED" },
    data: { status: "ACTIVE", error: null },
  });
  if (claimed.count === 0) return { ok: false, errors: ["This campaign is already being switched on."] };

  const objects = [
    ["campaign", row.metaCampaignId],
    ["adset", row.metaAdSetId],
    ["ad", row.metaAdId],
  ] as const;

  const switchedOn: string[] = [];
  try {
    for (const [step, id] of objects) {
      if (!id) throw new MetaAdsError(`The ${step} was not created in Meta, so it cannot be switched on.`, "missing", step);
      await setObjectStatus(accessToken, id, "ACTIVE", step, fetcher);
      switchedOn.push(id);
    }
    return { ok: true, status: "ACTIVE" };
  } catch (error) {
    // Anything switched on before the failure is switched back off, so a half-started
    // campaign never spends. Its failure is kept for the person to read.
    const message =
      error instanceof MetaAdsError
        ? `Meta refused the ${error.step} (${error.code}): ${error.message}`
        : "Switching the campaign on failed. Try again in a moment.";
    for (const id of switchedOn) {
      await setObjectStatus(accessToken, id, "PAUSED", "campaign", fetcher).catch(() => undefined);
    }
    await prisma.adCampaign.update({
      where: { id: row.id },
      data: { status: "FAILED", error: `${message} Everything was paused again.` },
    });
    return { ok: false, errors: [message] };
  }
}
