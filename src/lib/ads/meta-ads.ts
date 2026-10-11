import "server-only";
import { GRAPH } from "@/lib/facebook-oauth";
import type { AdCampaignInput } from "./validate";

/**
 * The four calls that create an ads campaign in Meta: the campaign, its ad set
 * (where the budget, schedule and audience live), the creative, and the ad.
 *
 * Every object is created PAUSED. Creating does not spend; only a later, separate
 * step turns the campaign on, and that step is not in this file.
 *
 * Each call's answer is the object's id, or a MetaAdsError carrying Meta's own
 * message. Tokens go in the request body and never into an error or a log.
 */

export class MetaAdsError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly step: "campaign" | "adset" | "creative" | "ad",
  ) {
    super(message);
    this.name = "MetaAdsError";
  }
}

/** Meta's objective names differ from the ones the person sees in the chat. */
const OPTIMIZATION: Record<AdCampaignInput["objective"], string> = {
  OUTCOME_AWARENESS: "REACH",
  OUTCOME_TRAFFIC: "LINK_CLICKS",
  OUTCOME_ENGAGEMENT: "POST_ENGAGEMENT",
};

type Post = (path: string, body: Record<string, string>) => Promise<{ id?: string }>;

/** A POST to the Graph API. Exported so tests can stand in for Meta. */
export function graphPost(accessToken: string, fetcher: typeof fetch = fetch): Post {
  return async (path, body) => {
    const response = await fetcher(`${GRAPH}${path}`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ ...body, access_token: accessToken }),
      cache: "no-store",
    });
    const json = (await response.json().catch(() => ({}))) as {
      id?: string;
      error?: { message?: string; code?: number };
    };
    if (!response.ok || json.error || !json.id) {
      throw new MetaAdsError(
        json.error?.message ?? `Meta answered HTTP ${response.status} without an id.`,
        String(json.error?.code ?? response.status),
        "campaign",
      );
    }
    return json;
  };
}

export type MetaAdIds = { campaignId: string; adSetId: string; creativeId: string; adId: string };

/**
 * Creates the four objects in order. Each id is handed to `saved` the moment Meta
 * returns it, so if a later call fails the caller already holds every object that
 * exists in Meta and nothing is left behind unrecorded.
 */
export async function createPausedAd(
  post: Post,
  input: AdCampaignInput,
  saved: (key: keyof MetaAdIds, id: string) => Promise<void> = async () => {},
): Promise<MetaAdIds> {
  const seconds = (date: Date) => String(Math.floor(date.getTime() / 1000));
  const fail = (step: MetaAdsError["step"]) => (error: unknown): never => {
    if (error instanceof MetaAdsError) throw new MetaAdsError(error.message, error.code, step);
    throw error;
  };

  const campaign = await post(`/${input.adAccountId}/campaigns`, {
    name: input.name,
    objective: input.objective,
    status: "PAUSED",
    special_ad_categories: "[]",
  }).catch(fail("campaign"));
  await saved("campaignId", campaign.id!);

  const adSet = await post(`/${input.adAccountId}/adsets`, {
    name: `${input.name} · ad set`,
    campaign_id: campaign.id!,
    daily_budget: String(input.dailyBudgetCents),
    billing_event: "IMPRESSIONS",
    optimization_goal: OPTIMIZATION[input.objective],
    bid_strategy: "LOWEST_COST_WITHOUT_CAP",
    start_time: seconds(input.startsAt),
    end_time: seconds(input.endsAt),
    promoted_object: JSON.stringify({ page_id: input.pageId }),
    targeting: JSON.stringify({
      geo_locations: { countries: input.targeting.countries },
      age_min: input.targeting.ageMin,
      age_max: input.targeting.ageMax,
      publisher_platforms: input.platforms,
    }),
    status: "PAUSED",
  }).catch(fail("adset"));
  await saved("adSetId", adSet.id!);

  const linkData: Record<string, string> = {
    link: input.linkUrl,
    message: input.caption,
  };
  if (input.mediaUrl) linkData.picture = input.mediaUrl;

  const creative = await post(`/${input.adAccountId}/adcreatives`, {
    name: `${input.name} · creative`,
    object_story_spec: JSON.stringify({ page_id: input.pageId, link_data: linkData }),
  }).catch(fail("creative"));
  await saved("creativeId", creative.id!);

  const ad = await post(`/${input.adAccountId}/ads`, {
    name: `${input.name} · ad`,
    adset_id: adSet.id!,
    creative: JSON.stringify({ creative_id: creative.id! }),
    status: "PAUSED",
  }).catch(fail("ad"));
  await saved("adId", ad.id!);

  return {
    campaignId: campaign.id!,
    adSetId: adSet.id!,
    creativeId: creative.id!,
    adId: ad.id!,
  };
}

/**
 * Sets one object's status (ACTIVE or PAUSED). Meta answers `{ success: true }`
 * rather than an id, so this checks the answer itself and names the step it was
 * for, so a refusal is reported against the object that refused.
 */
export async function setObjectStatus(
  accessToken: string,
  objectId: string,
  status: "ACTIVE" | "PAUSED",
  step: MetaAdsError["step"],
  fetcher: typeof fetch = fetch,
): Promise<void> {
  const response = await fetcher(`${GRAPH}/${objectId}`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ status, access_token: accessToken }),
    cache: "no-store",
  });
  const json = (await response.json().catch(() => ({}))) as {
    success?: boolean;
    error?: { message?: string; code?: number };
  };
  if (!response.ok || json.error || json.success !== true) {
    throw new MetaAdsError(
      json.error?.message ?? `Meta answered HTTP ${response.status} without confirming the change.`,
      String(json.error?.code ?? response.status),
      step,
    );
  }
}
