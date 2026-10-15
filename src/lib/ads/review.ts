/**
 * What the person is shown, and must confirm, before a paused campaign is switched
 * on. Pure, so the number they confirm is the number the server recomputes.
 *
 * Meta spends up to the daily budget on each day the campaign runs. The total below
 * is the most it can spend, counting each calendar day of the run (UTC) once. It is
 * a ceiling Meta respects, not a forecast: a campaign can spend less.
 */

const DAY_MS = 24 * 60 * 60 * 1000;

export type ReviewInput = {
  name: string;
  objective: string;
  dailyBudgetCents: number;
  startsAt: Date;
  endsAt: Date;
  platforms: string[];
  targeting: { countries: string[]; ageMin: number; ageMax: number };
};

export type CampaignReview = {
  /** Most it can spend, in minor units of the account's currency. */
  maxTotalCents: number;
  days: number;
  /** A short line for the chat and the screen, in the same order. */
  lines: string[];
};

/** Calendar days in UTC from start to end, both included. */
export function runDays(startsAt: Date, endsAt: Date): number {
  const startDay = Date.UTC(startsAt.getUTCFullYear(), startsAt.getUTCMonth(), startsAt.getUTCDate());
  const endDay = Date.UTC(endsAt.getUTCFullYear(), endsAt.getUTCMonth(), endsAt.getUTCDate());
  return Math.round((endDay - startDay) / DAY_MS) + 1;
}

export function reviewCampaign(input: ReviewInput): CampaignReview {
  const days = runDays(input.startsAt, input.endsAt);
  const maxTotalCents = input.dailyBudgetCents * days;
  return {
    maxTotalCents,
    days,
    lines: [
      `Campaign: ${input.name}`,
      `Objective: ${input.objective}`,
      `Platforms: ${input.platforms.join(", ")}`,
      `Audience: ${input.targeting.countries.join(", ")}, ages ${input.targeting.ageMin}–${input.targeting.ageMax}`,
      `Runs: ${input.startsAt.toISOString()} → ${input.endsAt.toISOString()} (UTC), ${days} day${days === 1 ? "" : "s"}`,
      `Daily budget: ${input.dailyBudgetCents} (minor units); up to ${maxTotalCents} in total`,
    ],
  };
}
