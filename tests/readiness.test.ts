import { describe, expect, it } from "vitest";
import {
  formatBytes,
  formatDuration,
  readinessFor,
  relativeDays,
  waitingFor,
} from "@/lib/readiness";

/**
 * readinessFor() answers "does it work for me" for every card, product page and
 * workspace row. Each case below is one of the distinctions it draws — the
 * precedence between them is the part a card and a page could disagree about.
 */

const sheets = {
  label: "Google Sheets",
  credentialType: "googleSheetsOAuth2Api",
  providedBy: "USER",
} as const;

const slack = {
  label: "Slack",
  credentialType: "slackApi",
  providedBy: "USER",
} as const;

const platformModel = {
  label: "AI model",
  credentialType: null,
  providedBy: "PLATFORM",
} as const;

const active = (credentialType: string) =>
  ({ credentialType, status: "ACTIVE" }) as const;
const expired = (credentialType: string) =>
  ({ credentialType, status: "EXPIRED" }) as const;

describe("readinessFor", () => {
  it("is ready when every requirement the user owns is connected", () => {
    const result = readinessFor({
      productStatus: "PUBLISHED",
      requirements: [sheets, platformModel],
      accounts: [active("googleSheetsOAuth2Api")],
    });

    expect(result).toEqual({ tone: "ready", label: "Ready", missing: [] });
  });

  it("ignores requirements the platform provides", () => {
    // The platform's own model and file access are not the user's to connect,
    // so a product that needs only those is ready with no accounts at all.
    const result = readinessFor({
      productStatus: "PUBLISHED",
      requirements: [platformModel],
      accounts: [],
    });

    expect(result.tone).toBe("ready");
  });

  it("counts the connections still missing, before installing", () => {
    const result = readinessFor({
      productStatus: "PUBLISHED",
      requirements: [sheets, slack],
      accounts: [],
    });

    expect(result.tone).toBe("partial");
    expect(result.label).toBe("Needs 2 connections");
    expect(result.missing).toEqual(["Google Sheets", "Slack"]);
  });

  it("uses the singular for one missing connection", () => {
    const result = readinessFor({
      productStatus: "PUBLISHED",
      requirements: [sheets, slack],
      accounts: [active("slackApi")],
    });

    expect(result.label).toBe("Needs 1 connection");
  });

  it("reads as partially ready once it is in the workspace", () => {
    const result = readinessFor({
      productStatus: "PUBLISHED",
      requirements: [sheets],
      accounts: [],
      installed: true,
      installationStatus: "PARTIAL",
    });

    expect(result.tone).toBe("partial");
    expect(result.label).toBe("Partially ready");
  });

  it("treats an expired account on an installed product as blocked, not partial", () => {
    // The distinction that matters to the user: this is the next run failing,
    // not a setup step they have yet to do.
    const result = readinessFor({
      productStatus: "PUBLISHED",
      requirements: [sheets],
      accounts: [expired("googleSheetsOAuth2Api")],
      installed: true,
    });

    expect(result.tone).toBe("blocked");
    expect(result.label).toBe("Blocked");
    expect(result.missing).toEqual(["Google Sheets"]);
  });

  it("treats the same expired account as a setup step before installing", () => {
    const result = readinessFor({
      productStatus: "PUBLISHED",
      requirements: [sheets],
      accounts: [expired("googleSheetsOAuth2Api")],
    });

    expect(result.tone).toBe("partial");
  });

  it("lists never-connected before expired, so the first thing to do comes first", () => {
    const result = readinessFor({
      productStatus: "PUBLISHED",
      requirements: [sheets, slack],
      accounts: [expired("googleSheetsOAuth2Api")],
    });

    expect(result.missing).toEqual(["Slack", "Google Sheets"]);
  });

  describe("product status wins over connections", () => {
    it("suspends for everyone, installed or not", () => {
      for (const installed of [true, false]) {
        const result = readinessFor({
          productStatus: "SUSPENDED",
          requirements: [sheets],
          accounts: [active("googleSheetsOAuth2Api")],
          installed,
        });
        expect(result).toEqual({ tone: "blocked", label: "Suspended", missing: [] });
      }
    });

    it("treats a security hold the same as a suspension", () => {
      const result = readinessFor({
        productStatus: "SECURITY_HOLD",
        requirements: [],
        accounts: [],
        installed: true,
      });

      expect(result.label).toBe("Suspended");
    });

    it("closes a restricted product to new installs only", () => {
      const result = readinessFor({
        productStatus: "RESTRICTED",
        requirements: [sheets],
        accounts: [active("googleSheetsOAuth2Api")],
      });

      expect(result).toEqual({ tone: "restricted", label: "Restricted", missing: [] });
    });

    it("lets an existing user keep running a restricted product", () => {
      const result = readinessFor({
        productStatus: "RESTRICTED",
        requirements: [sheets],
        accounts: [active("googleSheetsOAuth2Api")],
        installed: true,
      });

      expect(result.tone).toBe("ready");
    });
  });

  it("blames the plan, not a connection, when over the limit", () => {
    const result = readinessFor({
      productStatus: "PUBLISHED",
      requirements: [sheets],
      accounts: [],
      overPlanLimit: true,
    });

    expect(result).toEqual({ tone: "plan", label: "Plan limit", missing: [] });
  });

  it("still reports a suspension ahead of the plan limit", () => {
    const result = readinessFor({
      productStatus: "SUSPENDED",
      requirements: [],
      accounts: [],
      overPlanLimit: true,
    });

    expect(result.label).toBe("Suspended");
  });

  it("reports a disabled installation, and still says what is missing", () => {
    const result = readinessFor({
      productStatus: "PUBLISHED",
      requirements: [sheets],
      accounts: [],
      installed: true,
      installationStatus: "DISABLED",
    });

    expect(result.tone).toBe("blocked");
    expect(result.label).toBe("Disabled");
    expect(result.missing).toEqual(["Google Sheets"]);
  });

  it("treats a requirement with no credential type as unconnectable", () => {
    // A USER requirement that names no credential type can never be satisfied
    // by an account, so it must not silently read as ready.
    const result = readinessFor({
      productStatus: "PUBLISHED",
      requirements: [{ label: "Mystery", credentialType: null, providedBy: "USER" }],
      accounts: [],
    });

    expect(result.tone).toBe("partial");
    expect(result.missing).toEqual(["Mystery"]);
  });
});

describe("formatBytes", () => {
  it.each([
    [0, "0 B"],
    [999, "999 B"],
    [1_000, "1 KB"],
    [999_999, "1000 KB"],
    [1_000_000, "1.0 MB"],
    [2_400_000, "2.4 MB"],
    [1_000_000_000, "1.0 GB"],
  ])("formats %i as %s", (bytes, expected) => {
    expect(formatBytes(bytes)).toBe(expected);
  });
});

describe("formatDuration", () => {
  it("returns an em dash for nothing, but not for zero", () => {
    expect(formatDuration(null)).toBe("—");
    expect(formatDuration(undefined)).toBe("—");
    expect(formatDuration(0)).toBe("0ms");
  });

  it.each([
    [999, "999ms"],
    [1_000, "1s"],
    [59_000, "59s"],
    [60_000, "1m 00s"],
    [125_000, "2m 05s"],
  ])("formats %ims as %s", (ms, expected) => {
    expect(formatDuration(ms)).toBe(expected);
  });
});

describe("relativeDays", () => {
  const now = new Date("2026-06-15T12:00:00Z");
  const ago = (ms: number) => new Date(now.getTime() - ms);

  it("never says 0h ago", () => {
    expect(relativeDays(ago(60_000), now)).toBe("1h ago");
  });

  it.each([
    [3 * 3_600_000, "3h ago"],
    [86_400_000, "1d ago"],
    [5 * 86_400_000, "5d ago"],
    [45 * 86_400_000, "2 months ago"],
  ])("formats %ims ago as %s", (ms, expected) => {
    expect(relativeDays(ago(ms), now)).toBe(expected);
  });

  it("uses the singular for a single month", () => {
    expect(relativeDays(ago(30 * 86_400_000), now)).toBe("1 month ago");
  });
});

describe("waitingFor", () => {
  const now = new Date("2026-06-15T12:00:00Z");

  it("never says 0h", () => {
    expect(waitingFor(new Date(now.getTime() - 60_000), now)).toBe("1h");
  });

  it("switches to days after a day", () => {
    expect(waitingFor(new Date(now.getTime() - 26 * 3_600_000), now)).toBe("1d");
  });
});
