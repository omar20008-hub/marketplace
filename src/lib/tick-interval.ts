/**
 * How often the in-process knowledge scheduler runs, from
 * KNOWLEDGE_TICK_INTERVAL_SECONDS. Kept apart from the scheduler so lib/env.ts
 * can read it without pulling the scheduler in.
 *
 * Absent, empty, zero, negative or not a number all mean "off" — the safe reading
 * of a setting nobody meant to set. A positive value below the floor is raised to
 * it: a typo of 1 must not become a request to hit the database every second.
 */

export const MIN_TICK_INTERVAL_SECONDS = 10;

export function parseTickInterval(raw: string | undefined): number {
  const seconds = Number(raw?.trim());
  if (!raw?.trim() || !Number.isFinite(seconds) || seconds <= 0) return 0;
  return Math.max(MIN_TICK_INTERVAL_SECONDS, Math.floor(seconds));
}
