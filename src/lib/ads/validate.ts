/**
 * What a person may ask an ads campaign to be, checked before anything is sent to
 * Meta. Pure on purpose: the same rules run in the chat, on the review screen and
 * on the server, so none of them can disagree.
 *
 * Money: the budget is in minor units of the ad account's currency (cents for USD),
 * the same unit Meta's API takes. The only spending limit is the one the person
 * sets on the campaign; there is no platform-wide cap.
 */

export const OBJECTIVES = ["OUTCOME_AWARENESS", "OUTCOME_TRAFFIC", "OUTCOME_ENGAGEMENT"] as const;
export type Objective = (typeof OBJECTIVES)[number];

export const PLATFORMS = ["facebook", "instagram"] as const;
export type AdPlatform = (typeof PLATFORMS)[number];

const MAX_NAME = 100;
const MAX_CAPTION = 2200;
const MIN_DAILY_BUDGET_CENTS = 100; // one unit of the currency; Meta refuses less
const MIN_LEAD_MS = 60_000;
const MAX_DURATION_MS = 365 * 24 * 60 * 60 * 1000;
const MAX_COUNTRIES = 25;
const AD_ACCOUNT = /^act_\d{5,20}$/;
const COUNTRY = /^[A-Z]{2}$/;
const IMAGE_EXTENSION = /\.(jpe?g|png)(\?.*)?$/i;

export type AdCampaignInput = {
  adAccountId: string;
  /** The Facebook Page the ad runs from. Meta needs it for every ad. */
  pageId: string;
  name: string;
  objective: Objective;
  dailyBudgetCents: number;
  startsAt: Date;
  endsAt: Date;
  targeting: { countries: string[]; ageMin: number; ageMax: number };
  platforms: AdPlatform[];
  caption: string;
  linkUrl: string;
  mediaUrl: string | null;
};

export type AdValidation = { ok: true; value: AdCampaignInput } | { ok: false; errors: string[] };

function https(value: string): boolean {
  try {
    return new URL(value).protocol === "https:";
  } catch {
    return false;
  }
}

/**
 * Accepts the raw fields a person or the workflow supplies. Every problem is
 * reported at once, so the person fixes them in one pass rather than one per try.
 * `now` is a parameter so the lead-time rule is testable.
 */
export function validateAdCampaign(raw: Record<string, unknown>, now: Date): AdValidation {
  const errors: string[] = [];
  const text = (key: string) => (typeof raw[key] === "string" ? (raw[key] as string).trim() : "");

  const adAccountId = text("adAccountId");
  if (!AD_ACCOUNT.test(adAccountId)) {
    errors.push("The ad account must look like act_1234567890. Pick it from your Meta ad accounts.");
  }

  const pageId = text("pageId");
  if (!/^\d{5,20}$/.test(pageId)) {
    errors.push("Pick the Facebook Page the ad runs from.");
  }

  const name = text("name");
  if (name.length < 3 || name.length > MAX_NAME) {
    errors.push(`The campaign name must be 3 to ${MAX_NAME} characters.`);
  }

  const objective = text("objective") as Objective;
  if (!OBJECTIVES.includes(objective)) {
    errors.push(`The objective must be one of: ${OBJECTIVES.join(", ")}.`);
  }

  const budget = raw.dailyBudgetCents;
  if (
    typeof budget !== "number" ||
    !Number.isInteger(budget) ||
    budget < MIN_DAILY_BUDGET_CENTS
  ) {
    errors.push("The daily budget must be a whole amount of at least one unit of your currency.");
  }

  const startsAt = raw.startsAt instanceof Date ? raw.startsAt : new Date(text("startsAt"));
  const endsAt = raw.endsAt instanceof Date ? raw.endsAt : new Date(text("endsAt"));
  if (Number.isNaN(startsAt.getTime()) || Number.isNaN(endsAt.getTime())) {
    errors.push("The start and end must be full dates and times.");
  } else {
    if (startsAt.getTime() < now.getTime() + MIN_LEAD_MS) {
      errors.push("The campaign must start at least a minute from now.");
    }
    if (endsAt.getTime() <= startsAt.getTime()) {
      errors.push("The campaign must end after it starts.");
    } else if (endsAt.getTime() - startsAt.getTime() > MAX_DURATION_MS) {
      errors.push("A campaign can run for at most a year.");
    }
  }

  const target = raw.targeting as { countries?: unknown; ageMin?: unknown; ageMax?: unknown } | undefined;
  const countries = Array.isArray(target?.countries) ? (target!.countries as unknown[]) : [];
  if (
    countries.length < 1 ||
    countries.length > MAX_COUNTRIES ||
    !countries.every((c) => typeof c === "string" && COUNTRY.test(c))
  ) {
    errors.push("Name at least one target country by its two-letter code, such as SA or US.");
  }
  const ageMin = target?.ageMin;
  const ageMax = target?.ageMax;
  if (
    typeof ageMin !== "number" ||
    typeof ageMax !== "number" ||
    !Number.isInteger(ageMin) ||
    !Number.isInteger(ageMax) ||
    ageMin < 18 ||
    ageMax > 65 ||
    ageMin > ageMax
  ) {
    errors.push("The target age must be whole numbers between 18 and 65, with the minimum first.");
  }

  const platforms = Array.isArray(raw.platforms) ? (raw.platforms as unknown[]) : [];
  if (
    platforms.length < 1 ||
    !platforms.every((p) => typeof p === "string" && (PLATFORMS as readonly string[]).includes(p))
  ) {
    errors.push("Choose Facebook, Instagram, or both.");
  }

  const caption = text("caption");
  if (caption.length < 1 || caption.length > MAX_CAPTION) {
    errors.push(`The ad text must be 1 to ${MAX_CAPTION} characters.`);
  }

  const linkUrl = text("linkUrl");
  if (!https(linkUrl)) {
    errors.push("The link the ad sends people to must be a full https address.");
  }

  const mediaUrl = text("mediaUrl") || null;
  if (mediaUrl) {
    if (!https(mediaUrl) || !IMAGE_EXTENSION.test(new URL(mediaUrl).pathname + new URL(mediaUrl).search)) {
      errors.push("The image must be a public https link to a JPEG or PNG file.");
    }
  }

  if (errors.length > 0) return { ok: false, errors };
  return {
    ok: true,
    value: {
      adAccountId,
      pageId,
      name,
      objective,
      dailyBudgetCents: budget as number,
      startsAt,
      endsAt,
      targeting: { countries: countries as string[], ageMin: ageMin as number, ageMax: ageMax as number },
      platforms: platforms as AdPlatform[],
      caption,
      linkUrl,
      mediaUrl,
    },
  };
}
