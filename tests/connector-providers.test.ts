import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/env", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/env")>();
  return { ...actual, env: { ...actual.env } };
});

const { editorsWithoutGrant } = await import("@/lib/connectors/providers");
const { sealCredential } = await import("@/lib/secrets");

const READ = "https://www.googleapis.com/auth/drive.readonly";
const ALL_EDITORS = [
  "https://www.googleapis.com/auth/spreadsheets",
  "https://www.googleapis.com/auth/documents",
  "https://www.googleapis.com/auth/presentations",
];

describe("Google editors a Drive connection lacks", () => {
  it("names all three editors for a connection made before they were added", () => {
    const secret = sealCredential({ refresh_token: "1//r", access_token: "a", scope: READ });
    expect(editorsWithoutGrant(secret)).toEqual(["Google Sheets", "Google Docs", "Google Slides"]);
  });

  it("names none once the connection holds every editor's scope", () => {
    const secret = sealCredential({ refresh_token: "1//r", access_token: "a", scope: [READ, ...ALL_EDITORS].join(" ") });
    expect(editorsWithoutGrant(secret)).toEqual([]);
  });

  it("names only the editor whose scope is missing", () => {
    const secret = sealCredential({
      refresh_token: "1//r",
      access_token: "a",
      scope: [READ, ALL_EDITORS[0], ALL_EDITORS[1]].join(" "),
    });
    expect(editorsWithoutGrant(secret)).toEqual(["Google Slides"]);
  });
});
