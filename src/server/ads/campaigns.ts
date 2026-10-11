import "server-only";
import { prisma } from "@/lib/db";
import { openCredential } from "@/lib/secrets";
import { FACEBOOK_CREDENTIAL } from "@/lib/facebook-oauth";
import { createPausedAd, graphPost, MetaAdsError, type MetaAdIds } from "@/lib/ads/meta-ads";
import { validateAdCampaign } from "@/lib/ads/validate";

/**
 * Creates an ads campaign in Meta, left PAUSED.
 *
 * The campaign row is written first, claimed (DRAFT → CREATING) so two requests
 * cannot both create it, and then each Meta id is saved the moment Meta returns
 * it. A refusal from Meta ends in FAILED with Meta's own words, and whatever was
 * created before the refusal is kept on the row for the person to see or remove.
 *
 * Activation is not here. Nothing in this file moves money.
 */

/** The ids the person needs to find the campaign in Ads Manager. The creative's id is internal. */
const KEY: Partial<Record<keyof MetaAdIds, "metaCampaignId" | "metaAdSetId" | "metaAdId">> = {
  campaignId: "metaCampaignId",
  adSetId: "metaAdSetId",
  adId: "metaAdId",
};

export type CreateAdResult =
  | { ok: true; campaignId: string; status: "PAUSED" }
  | { ok: false; errors: string[] };

export async function createAdCampaign(
  userId: string,
  raw: Record<string, unknown>,
  fetcher: typeof fetch = fetch,
  now = new Date(),
): Promise<CreateAdResult> {
  const checked = validateAdCampaign(raw, now);
  if (!checked.ok) return { ok: false, errors: checked.errors };
  const input = checked.value;

  const connection = await prisma.connectedAccount.findFirst({
    where: { userId, credentialType: FACEBOOK_CREDENTIAL, status: "ACTIVE" },
  });
  if (!connection?.secretJson) {
    return { ok: false, errors: ["Connect Facebook & Instagram with ads permission first."] };
  }
  if (connection.expiresAt && connection.expiresAt.getTime() < now.getTime()) {
    return { ok: false, errors: ["Your Facebook connection has expired. Sign in with Facebook again."] };
  }
  const accessToken = openCredential(connection.secretJson).accessToken;
  if (!accessToken) {
    return { ok: false, errors: ["Your Facebook connection has no usable token. Sign in again."] };
  }

  const row = await prisma.adCampaign.create({
    data: {
      userId,
      adAccountId: input.adAccountId,
      name: input.name,
      objective: input.objective,
      dailyBudgetCents: input.dailyBudgetCents,
      startsAt: input.startsAt,
      endsAt: input.endsAt,
      targeting: input.targeting,
      platforms: input.platforms,
      caption: input.caption,
      linkUrl: input.linkUrl,
      mediaUrl: input.mediaUrl,
      status: "DRAFT",
    },
  });

  // Only one request may move a draft on to Meta.
  const claimed = await prisma.adCampaign.updateMany({
    where: { id: row.id, status: "DRAFT" },
    data: { status: "CREATING" },
  });
  if (claimed.count === 0) {
    return { ok: false, errors: ["This campaign is already being created."] };
  }

  try {
    await createPausedAd(graphPost(accessToken, fetcher), input, async (key, id) => {
      const column = KEY[key];
      if (column) await prisma.adCampaign.update({ where: { id: row.id }, data: { [column]: id } });
    });
    await prisma.adCampaign.update({
      where: { id: row.id },
      data: { status: "PAUSED", error: null },
    });
    return { ok: true, campaignId: row.id, status: "PAUSED" };
  } catch (error) {
    const message =
      error instanceof MetaAdsError
        ? `Meta refused the ${error.step} (${error.code}): ${error.message}`
        : "Creating the campaign failed. Try again in a moment.";
    await prisma.adCampaign.update({
      where: { id: row.id },
      data: { status: "FAILED", error: message },
    });
    return { ok: false, errors: [message] };
  }
}
