import { describe, expect, it } from "vitest";
import { isValidCron, nextRun, parseCron } from "@/lib/cron";

/**
 * A wrong answer here is invisible: the schedule simply fires at a time nobody
 * asked for, a week later. So the cases below are the ones where a hand-written
 * cron reader usually goes wrong — the day-of-month/day-of-week OR rule, steps,
 * month and year rollover, and February.
 */

const at = (iso: string) => new Date(iso);
const next = (expression: string, from: string) =>
  nextRun(expression, at(from)).toISOString();

describe("nextRun — the basics", () => {
  it("is always strictly in the future, never the moment it was asked", () => {
    // 12:00 exactly, on an hourly schedule, must give 13:00 and not 12:00.
    expect(next("0 * * * *", "2026-03-10T12:00:00.000Z")).toBe(
      "2026-03-10T13:00:00.000Z",
    );
  });

  it("finds the next minute for a star schedule", () => {
    expect(next("* * * * *", "2026-03-10T12:00:30.000Z")).toBe(
      "2026-03-10T12:01:00.000Z",
    );
  });

  it("zeroes the seconds it was handed", () => {
    expect(next("*/5 * * * *", "2026-03-10T12:01:59.999Z")).toBe(
      "2026-03-10T12:05:00.000Z",
    );
  });

  it("finds a fixed daily time later today", () => {
    expect(next("0 18 * * *", "2026-03-10T09:00:00.000Z")).toBe(
      "2026-03-10T18:00:00.000Z",
    );
  });

  it("rolls to tomorrow once today's time has passed", () => {
    expect(next("0 7 * * *", "2026-03-10T09:00:00.000Z")).toBe(
      "2026-03-11T07:00:00.000Z",
    );
  });

  it("rolls across the end of a month", () => {
    expect(next("0 7 * * *", "2026-03-31T09:00:00.000Z")).toBe(
      "2026-04-01T07:00:00.000Z",
    );
  });

  it("rolls across the end of a year", () => {
    expect(next("30 11 * * *", "2026-12-31T23:00:00.000Z")).toBe(
      "2027-01-01T11:30:00.000Z",
    );
  });
});

describe("nextRun — the seeded schedules", () => {
  it("every Sunday 18:00", () => {
    // 2026-03-10 is a Tuesday; the next Sunday is the 15th.
    expect(next("0 18 * * 0", "2026-03-10T12:00:00.000Z")).toBe(
      "2026-03-15T18:00:00.000Z",
    );
  });

  it("daily 07:00", () => {
    expect(next("0 7 * * *", "2026-03-10T06:59:00.000Z")).toBe(
      "2026-03-10T07:00:00.000Z",
    );
  });

  it("weekdays 11:30 skips the weekend", () => {
    // Friday 13 March 2026, after the time → Monday the 16th.
    expect(next("30 11 * * 1-5", "2026-03-13T12:00:00.000Z")).toBe(
      "2026-03-16T11:30:00.000Z",
    );
  });

  it("every hour", () => {
    expect(next("0 * * * *", "2026-03-10T12:30:00.000Z")).toBe(
      "2026-03-10T13:00:00.000Z",
    );
  });
});

describe("the day-of-month and day-of-week rule", () => {
  it("matches either when both are restricted", () => {
    // "the 1st of the month, and every Monday" — not their intersection.
    // 2026-03-10 is a Tuesday; the next Monday is the 16th, before 1 April.
    expect(next("0 0 1 * MON", "2026-03-10T12:00:00.000Z")).toBe(
      "2026-03-16T00:00:00.000Z",
    );
  });

  it("still matches the day-of-month arm of that rule", () => {
    // From a Tuesday the 24th, the 1st comes before the following Monday only
    // if no Monday intervenes — here Monday the 30th is after 1 April, so the
    // 1st wins. Either way the point is that the 1st fires at all.
    expect(next("0 0 1 * MON", "2026-03-31T12:00:00.000Z")).toBe(
      "2026-04-01T00:00:00.000Z",
    );
  });

  it("uses only day-of-month when day-of-week is a star", () => {
    expect(next("0 0 15 * *", "2026-03-10T12:00:00.000Z")).toBe(
      "2026-03-15T00:00:00.000Z",
    );
  });

  it("uses only day-of-week when day-of-month is a star", () => {
    expect(next("0 0 * * FRI", "2026-03-10T12:00:00.000Z")).toBe(
      "2026-03-13T00:00:00.000Z",
    );
  });

  it("treats a starred field with a step as unrestricted", () => {
    // */2 on day-of-week keeps the star behaviour, so day-of-month alone
    // decides. This is what Vixie cron does, and a pasted expression means it.
    const parsed = parseCron("0 0 5 * */2");
    expect(parsed.dayOfWeek.restricted).toBe(false);
    expect(next("0 0 5 * */2", "2026-03-10T12:00:00.000Z")).toBe(
      "2026-04-05T00:00:00.000Z",
    );
  });
});

describe("steps, ranges and lists", () => {
  it("expands a star with a step", () => {
    expect(parseCron("*/15 * * * *").minute.values).toEqual([0, 15, 30, 45]);
  });

  it("expands a range with a step", () => {
    expect(parseCron("0 8-18/4 * * *").hour.values).toEqual([8, 12, 16]);
  });

  it("reads a bare value with a step as running to the end of the field", () => {
    expect(parseCron("5/10 * * * *").minute.values).toEqual([5, 15, 25, 35, 45, 55]);
  });

  it("expands a comma list", () => {
    expect(parseCron("0,30 * * * *").minute.values).toEqual([0, 30]);
  });

  it("merges overlapping list parts without duplicating", () => {
    expect(parseCron("1-5,3-7 * * * *").minute.values).toEqual([1, 2, 3, 4, 5, 6, 7]);
  });

  it("walks a list in order across an hour", () => {
    expect(next("0,30 * * * *", "2026-03-10T12:10:00.000Z")).toBe(
      "2026-03-10T12:30:00.000Z",
    );
    expect(next("0,30 * * * *", "2026-03-10T12:45:00.000Z")).toBe(
      "2026-03-10T13:00:00.000Z",
    );
  });
});

describe("names", () => {
  it("reads month names", () => {
    expect(parseCron("0 0 1 JAN *").month.values).toEqual([1]);
    expect(parseCron("0 0 1 dec *").month.values).toEqual([12]);
  });

  it("reads day names, and a range of them", () => {
    expect(parseCron("0 0 * * SUN").dayOfWeek.values).toEqual([0]);
    expect(parseCron("0 0 * * MON-FRI").dayOfWeek.values).toEqual([1, 2, 3, 4, 5]);
  });

  it("folds 7 onto Sunday, so both spellings mean the same day", () => {
    expect(parseCron("0 0 * * 7").dayOfWeek.values).toEqual([0]);
    expect(next("0 0 * * 7", "2026-03-10T12:00:00.000Z")).toBe(
      next("0 0 * * 0", "2026-03-10T12:00:00.000Z"),
    );
  });
});

describe("macros", () => {
  it.each([
    ["@hourly", "2026-03-10T13:00:00.000Z"],
    ["@daily", "2026-03-11T00:00:00.000Z"],
    ["@midnight", "2026-03-11T00:00:00.000Z"],
    ["@weekly", "2026-03-15T00:00:00.000Z"],
    ["@monthly", "2026-04-01T00:00:00.000Z"],
    ["@yearly", "2027-01-01T00:00:00.000Z"],
  ])("%s", (macro, expected) => {
    expect(next(macro, "2026-03-10T12:30:00.000Z")).toBe(expected);
  });
});

describe("February and other awkward dates", () => {
  it("finds 29 February in the next leap year", () => {
    expect(next("0 0 29 2 *", "2026-03-10T12:00:00.000Z")).toBe(
      "2028-02-29T00:00:00.000Z",
    );
  });

  it("skips a 31st in months that have none", () => {
    // After 31 March, the next 31st is May, not April.
    expect(next("0 0 31 * *", "2026-03-31T12:00:00.000Z")).toBe(
      "2026-05-31T00:00:00.000Z",
    );
  });

  it("refuses a date that can never happen", () => {
    expect(() => nextRun("0 0 30 2 *", at("2026-03-10T12:00:00.000Z"))).toThrow(
      /never fire/,
    );
  });
});

describe("what it refuses, and how it says so", () => {
  it.each([
    ["", /empty/],
    ["0 0 * *", /four fields|fields, and five/],
    ["0 0 0 * * *", /six fields/],
    ["0 0 L * *", /Quartz/],
    ["0 0 * * 6#3", /Quartz/],
    ["0 0 ? * *", /Quartz/],
    ["60 * * * *", /between 0 and 59/],
    ["* 24 * * *", /between 0 and 23/],
    ["* * 32 * *", /between 1 and 31/],
    ["* * * 13 *", /between 1 and 12/],
    ["* * * * 8", /between 0 and 7/],
    ["5-1 * * * *", /backwards/],
    ["*/0 * * * *", /positive number/],
    ["*/2/3 * * * *", /more than one step/],
    ["abc * * * *", /not a value/],
    ["@never", /not one of/],
  ])("refuses %s", (expression, message) => {
    expect(() => parseCron(expression)).toThrow(message);
  });

  it("names the expression in the error, so the message is actionable", () => {
    expect(() => parseCron("99 * * * *")).toThrow(/"99 \* \* \* \*"/);
  });
});

describe("isValidCron", () => {
  it("accepts what nextRun can run", () => {
    for (const expression of ["0 18 * * 0", "*/5 * * * *", "@daily", "30 11 * * 1-5"]) {
      expect(isValidCron(expression)).toBe(true);
    }
  });

  it("rejects what it cannot, including a date that never comes", () => {
    for (const expression of ["", "nonsense", "0 0 30 2 *", "0 0 * * 9"]) {
      expect(isValidCron(expression)).toBe(false);
    }
  });
});

describe("repeated application", () => {
  it("produces a strictly increasing series with no gaps or repeats", () => {
    let cursor = at("2026-03-10T12:00:00.000Z");
    const seen: string[] = [];
    for (let i = 0; i < 8; i++) {
      cursor = nextRun("0 */6 * * *", cursor);
      seen.push(cursor.toISOString());
    }

    expect(seen).toEqual([
      "2026-03-10T18:00:00.000Z",
      "2026-03-11T00:00:00.000Z",
      "2026-03-11T06:00:00.000Z",
      "2026-03-11T12:00:00.000Z",
      "2026-03-11T18:00:00.000Z",
      "2026-03-12T00:00:00.000Z",
      "2026-03-12T06:00:00.000Z",
      "2026-03-12T12:00:00.000Z",
    ]);
  });

  it("never returns the same instant twice when fed its own output", () => {
    let cursor = at("2026-03-10T12:00:00.000Z");
    for (let i = 0; i < 50; i++) {
      const following = nextRun("*/7 * * * *", cursor);
      expect(following.getTime()).toBeGreaterThan(cursor.getTime());
      cursor = following;
    }
  });
});
