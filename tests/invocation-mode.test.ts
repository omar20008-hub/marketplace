import { describe, expect, it } from "vitest";
import { invocationModeLabel, isOnDemand, isScheduled, runsAutomatically } from "@/lib/invocation-mode";

/**
 * n8n's reply is comma-separated, not one of three exclusive values: a
 * workflow can combine an Execute Workflow Trigger with an autonomous one
 * (observed in production as "on_demand,event" for a chat agent that also
 * reacts to an incoming event). Every rule here has to hold for a combined
 * value, not just the three single ones the spec named.
 */

describe("invocationModeLabel", () => {
  it("labels each single mode", () => {
    expect(invocationModeLabel("on_demand")).toBe("يُستدعى عند الطلب من المحادثة");
    expect(invocationModeLabel("scheduled")).toBe("يعمل بجدولة تلقائية");
    expect(invocationModeLabel("event")).toBe("يعمل تلقائياً عند حدث معيّن");
  });

  it("combines labels for a comma-separated value", () => {
    expect(invocationModeLabel("on_demand,event")).toBe(
      "يُستدعى عند الطلب من المحادثة + يعمل تلقائياً عند حدث معيّن",
    );
  });

  it("falls back to on_demand for an empty or unrecognised value", () => {
    expect(invocationModeLabel("")).toBe(invocationModeLabel("on_demand"));
    expect(invocationModeLabel("something_new")).toBe(invocationModeLabel("on_demand"));
  });
});

describe("isOnDemand", () => {
  it("is true for a pure on_demand product", () => {
    expect(isOnDemand("on_demand")).toBe(true);
  });

  it("is true for a product combined with an automatic trigger", () => {
    // The chat interface can still call it — the workspace Run button must
    // not disappear just because it also reacts to a schedule or an event.
    expect(isOnDemand("on_demand,scheduled")).toBe(true);
    expect(isOnDemand("on_demand,event")).toBe(true);
  });

  it("is false for a pure scheduled or event product", () => {
    expect(isOnDemand("scheduled")).toBe(false);
    expect(isOnDemand("event")).toBe(false);
  });
});

describe("runsAutomatically", () => {
  it("is false for a pure on_demand product", () => {
    expect(runsAutomatically("on_demand")).toBe(false);
  });

  it("is true whenever scheduled or event is present, combined or not", () => {
    expect(runsAutomatically("scheduled")).toBe(true);
    expect(runsAutomatically("event")).toBe(true);
    expect(runsAutomatically("on_demand,scheduled")).toBe(true);
    expect(runsAutomatically("on_demand,event")).toBe(true);
  });
});

describe("isScheduled", () => {
  it("is true only when scheduled is one of the modes", () => {
    expect(isScheduled("scheduled")).toBe(true);
    expect(isScheduled("on_demand,scheduled")).toBe(true);
    expect(isScheduled("on_demand")).toBe(false);
    expect(isScheduled("event")).toBe(false);
  });
});
