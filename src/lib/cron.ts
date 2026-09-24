/**
 * The cron half of scheduling: when does this expression next come round?
 *
 * Deliberately a documented subset rather than a permissive parser. Anything it
 * does not understand throws, because a schedule that silently parses to the
 * wrong minute is worse than one that refuses to be saved: the user is told at
 * the moment they can still fix it, instead of wondering for a week why nothing
 * ran.
 *
 * Supported, in the five standard fields `minute hour day-of-month month
 * day-of-week`:
 *
 *   - a star, for every value
 *   - 5, one value
 *   - 1-5, a range, inclusive
 *   - 1-9/2, a range with a step, and a star with a step for every Nth value
 *   - 5/10, from 5 to the top of the field, in steps
 *   - 1,3,10-12, a comma list of any of the above
 *   - JAN..DEC month names, and SUN..SAT for day-of-week
 *   - @daily, and @hourly, @weekly, @monthly, @yearly, @midnight, @annually
 *
 * Not supported, and refused by name: `L`, `W`, `#`, `?`, and six-field
 * expressions with seconds. Quartz writes those; Unix cron does not, and the
 * schedules here come from a picker rather than from a paste.
 *
 * Everything is UTC. A schedule reads "18:00" to the user and fires at 18:00
 * UTC, which is why the screen labels it so. Per-user time zones need a column
 * on Schedule and a decision about what a daily 02:30 means on the night a
 * zone skips 02:30 altogether; neither is guessed at here.
 */

export type CronField = {
  /** The values this field matches, ascending. */
  values: number[];
  /** False when the field was `*`, which the day-of-month rule depends on. */
  restricted: boolean;
};

export type ParsedCron = {
  minute: CronField;
  hour: CronField;
  dayOfMonth: CronField;
  month: CronField;
  dayOfWeek: CronField;
};

const MACROS: Record<string, string> = {
  "@yearly": "0 0 1 1 *",
  "@annually": "0 0 1 1 *",
  "@monthly": "0 0 1 * *",
  "@weekly": "0 0 * * 0",
  "@daily": "0 0 * * *",
  "@midnight": "0 0 * * *",
  "@hourly": "0 * * * *",
};

const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
const DAYS = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];

type FieldSpec = {
  name: string;
  min: number;
  max: number;
  names?: string[];
  /** Day-of-week accepts 7 for Sunday, which folds onto 0. */
  fold?: (value: number) => number;
};

const SPECS: FieldSpec[] = [
  { name: "minute", min: 0, max: 59 },
  { name: "hour", min: 0, max: 23 },
  { name: "day-of-month", min: 1, max: 31 },
  { name: "month", min: 1, max: 12, names: MONTHS },
  { name: "day-of-week", min: 0, max: 7, names: DAYS, fold: (v) => v % 7 },
];

function fail(expression: string, reason: string): never {
  throw new Error(`Cannot read the schedule "${expression}": ${reason}`);
}

function parseValue(raw: string, spec: FieldSpec, expression: string): number {
  const text = raw.trim().toLowerCase();

  if (spec.names) {
    const index = spec.names.indexOf(text);
    // Month names are 1-based, day names 0-based, which is the field's own min.
    if (index >= 0) return index + spec.min;
  }

  if (!/^\d+$/.test(text)) {
    fail(expression, `"${raw}" is not a value ${spec.name} accepts.`);
  }

  const value = Number(text);
  if (value < spec.min || value > spec.max) {
    fail(
      expression,
      `${spec.name} must be between ${spec.min} and ${spec.max}, but got ${value}.`,
    );
  }
  return value;
}

function parseField(raw: string, spec: FieldSpec, expression: string): CronField {
  for (const character of ["L", "W", "#", "?"]) {
    if (raw.toUpperCase().includes(character)) {
      fail(
        expression,
        `"${character}" is a Quartz extension this scheduler does not support.`,
      );
    }
  }

  const found = new Set<number>();
  let restricted = true;

  for (const part of raw.split(",")) {
    const [rangePart, stepPart, ...rest] = part.split("/");
    if (rest.length > 0) fail(expression, `"${part}" has more than one step.`);

    let step = 1;
    if (stepPart !== undefined) {
      if (!/^\d+$/.test(stepPart) || Number(stepPart) === 0) {
        fail(expression, `"${part}" has a step that is not a positive number.`);
      }
      step = Number(stepPart);
    }

    let from: number;
    let to: number;

    if (rangePart === "*") {
      // A star makes the field unrestricted even with a step, which is what
      // the day-of-month rule below keys off — and what Vixie cron does.
      restricted = false;
      from = spec.min;
      to = spec.max;
    } else if (rangePart.includes("-")) {
      const [start, end, ...extra] = rangePart.split("-");
      if (extra.length > 0) fail(expression, `"${part}" is not a range.`);
      from = parseValue(start, spec, expression);
      to = parseValue(end, spec, expression);
      if (to < from) {
        fail(expression, `"${part}" runs backwards; ranges do not wrap.`);
      }
    } else {
      from = parseValue(rangePart, spec, expression);
      // A bare value with a step means "from here to the end of the field",
      // which is how Vixie cron reads 5/10.
      to = stepPart === undefined ? from : spec.max;
    }

    for (let value = from; value <= to; value += step) {
      found.add(spec.fold ? spec.fold(value) : value);
    }
  }

  if (found.size === 0) fail(expression, `"${raw}" matches nothing.`);

  return { values: [...found].sort((a, b) => a - b), restricted };
}

export function parseCron(expression: string): ParsedCron {
  const trimmed = expression.trim();
  if (!trimmed) fail(expression, "it is empty.");

  const expanded = trimmed.startsWith("@")
    ? (MACROS[trimmed.toLowerCase()] ??
      fail(
        expression,
        `"${trimmed}" is not one of ${Object.keys(MACROS).join(", ")}.`,
      ))
    : trimmed;

  const fields = expanded.split(/\s+/);
  if (fields.length === 6) {
    fail(
      expression,
      "it has six fields. This scheduler runs to the minute, so seconds are not accepted.",
    );
  }
  if (fields.length !== 5) {
    fail(expression, `it has ${fields.length} fields, and five are expected.`);
  }

  const [minute, hour, dayOfMonth, month, dayOfWeek] = fields.map((field, index) =>
    parseField(field, SPECS[index], expression),
  );

  return { minute, hour, dayOfMonth, month, dayOfWeek };
}

/**
 * Whether a date's day matches.
 *
 * The rule that surprises people: when day-of-month and day-of-week are both
 * restricted, a day matching *either* one counts. "1 * 1 * MON" is the first of
 * the month and every Monday, not Mondays that fall on the first. That is what
 * Unix cron has always done, so it is what a pasted expression means.
 */
function dayMatches(date: Date, cron: ParsedCron): boolean {
  const dom = cron.dayOfMonth.values.includes(date.getUTCDate());
  const dow = cron.dayOfWeek.values.includes(date.getUTCDay());

  if (cron.dayOfMonth.restricted && cron.dayOfWeek.restricted) return dom || dow;
  if (cron.dayOfMonth.restricted) return dom;
  if (cron.dayOfWeek.restricted) return dow;
  return true;
}

/** The smallest value in the field greater than or equal to `from`, if any. */
function atLeast(field: CronField, from: number): number | null {
  for (const value of field.values) if (value >= from) return value;
  return null;
}

/**
 * The first time this expression matches strictly after `after`.
 *
 * Walks by the largest unit that can be ruled out — a whole month, then a day,
 * then an hour — rather than minute by minute, so an expression like
 * "0 0 29 2 *" costs a few hundred steps rather than two million.
 */
export function nextRun(expression: string, after: Date = new Date()): Date {
  const cron = parseCron(expression);

  // Start at the top of the next minute: a run is always strictly in the future.
  const candidate = new Date(after.getTime());
  candidate.setUTCSeconds(0, 0);
  candidate.setUTCMinutes(candidate.getUTCMinutes() + 1);

  // Four years covers the longest real gap, 29 February on a century boundary.
  const limit = new Date(candidate.getTime());
  limit.setUTCFullYear(limit.getUTCFullYear() + 4);

  while (candidate <= limit) {
    if (!cron.month.values.includes(candidate.getUTCMonth() + 1)) {
      // Next month, from its first minute.
      candidate.setUTCMonth(candidate.getUTCMonth() + 1, 1);
      candidate.setUTCHours(0, 0, 0, 0);
      continue;
    }

    if (!dayMatches(candidate, cron)) {
      candidate.setUTCDate(candidate.getUTCDate() + 1);
      candidate.setUTCHours(0, 0, 0, 0);
      continue;
    }

    const hour = atLeast(cron.hour, candidate.getUTCHours());
    if (hour === null) {
      candidate.setUTCDate(candidate.getUTCDate() + 1);
      candidate.setUTCHours(0, 0, 0, 0);
      continue;
    }
    if (hour !== candidate.getUTCHours()) {
      candidate.setUTCHours(hour, 0, 0, 0);
    }

    const minute = atLeast(cron.minute, candidate.getUTCMinutes());
    if (minute === null) {
      // Past the last minute of this hour; try the next one.
      candidate.setUTCHours(candidate.getUTCHours() + 1, 0, 0, 0);
      continue;
    }
    candidate.setUTCMinutes(minute, 0, 0);

    return candidate;
  }

  fail(
    expression,
    "it has no next run within four years, so it can never fire. 30 February is the usual cause.",
  );
}

/** True when the expression is one this scheduler can run. */
export function isValidCron(expression: string): boolean {
  try {
    nextRun(expression, new Date());
    return true;
  } catch {
    return false;
  }
}
