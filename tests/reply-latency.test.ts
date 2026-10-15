import { describe, expect, it } from "vitest";
import {
  MAX_AVG_REPLY_MS,
  MAX_REPLY_MS,
  assertReplyLatency,
  summarizeLatencies,
} from "@/lib/reply-latency";

describe("reply latency limits", () => {
  it("exports the 3 minute and 2 minute limits", () => {
    expect(MAX_REPLY_MS).toBe(180_000);
    expect(MAX_AVG_REPLY_MS).toBe(120_000);
  });

  it("summarizes count, max and average", () => {
    expect(summarizeLatencies([10, 20, 60])).toEqual({ count: 3, maxMs: 60, avgMs: 30 });
  });

  it("rejects empty, negative and non-finite input", () => {
    expect(() => summarizeLatencies([])).toThrow();
    expect(() => summarizeLatencies([1, -1])).toThrow();
    expect(() => summarizeLatencies([Number.NaN])).toThrow();
    expect(() => summarizeLatencies([Infinity])).toThrow();
  });

  it("passes exactly at the limits", () => {
    expect(() => assertReplyLatency([180_000, 60_000])).not.toThrow();
    expect(() => assertReplyLatency([120_000])).not.toThrow();
  });

  it("fails one millisecond over the single-reply limit", () => {
    expect(() => assertReplyLatency([180_001])).toThrow(/180000/);
  });

  it("fails one millisecond over the average limit", () => {
    expect(() => assertReplyLatency([120_001])).toThrow(/Average/);
    expect(() => assertReplyLatency([120_000, 120_002])).toThrow(/Average/);
  });
});
