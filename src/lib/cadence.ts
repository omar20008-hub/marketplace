/**
 * The cadences the schedule picker offers, and the cron each one means.
 *
 * A free-text cron box would be the smaller thing to build and the worse thing
 * to use: "0 18 * * 0" is not a sentence anyone reads back confidently, and a
 * digit in the wrong field is invisible until a week has passed. The picker
 * covers what schedules here actually are, and lib/cron.ts still understands
 * far more than this — so a row created by other means keeps working.
 *
 * Its own module rather than beside the action that uses it, because a
 * "use server" file may only export async functions, and the form needs these
 * to render the options.
 */

export const CADENCES = ["hourly", "daily", "weekdays", "weekly", "monthly"] as const;

export type Cadence = (typeof CADENCES)[number];

export const CADENCE_LABELS: Record<Cadence, string> = {
  hourly: "Every hour",
  daily: "Every day",
  weekdays: "Weekdays",
  weekly: "Every week",
  monthly: "Every month",
};

export const DAY_NAMES = [
  "Sunday",
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
];

export function isCadence(value: string): value is Cadence {
  return (CADENCES as readonly string[]).includes(value);
}

/** True for a 24-hour HH:MM. */
export function isTimeOfDay(value: string): boolean {
  return /^([01]\d|2[0-3]):([0-5]\d)$/.test(value);
}

/** The cron expression a cadence means. Times are UTC, as the labels say. */
export function cronFor(cadence: Cadence, time: string, weekday: number): string {
  const [hour, minute] = time.split(":").map(Number);

  switch (cadence) {
    case "hourly":
      return "0 * * * *";
    case "daily":
      return `${minute} ${hour} * * *`;
    case "weekdays":
      return `${minute} ${hour} * * 1-5`;
    case "weekly":
      return `${minute} ${hour} * * ${weekday}`;
    case "monthly":
      return `${minute} ${hour} 1 * *`;
  }
}

/**
 * What the row says it does. UTC is spelled out rather than assumed: the
 * scheduler has no per-user time zone, so a label that said only "18:00" would
 * read as local time to everyone who is not on it.
 */
export function cadenceLabel(cadence: Cadence, time: string, weekday: number): string {
  switch (cadence) {
    case "hourly":
      return "Every hour";
    case "daily":
      return `Every day ${time} UTC`;
    case "weekdays":
      return `Weekdays ${time} UTC`;
    case "weekly":
      return `Every ${DAY_NAMES[weekday] ?? "Sunday"} ${time} UTC`;
    case "monthly":
      return `1st of the month ${time} UTC`;
  }
}
