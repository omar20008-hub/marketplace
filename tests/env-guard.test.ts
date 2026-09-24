import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * The startup guard on secrets.
 *
 * This is the one check nothing downstream can make for it: a session signed
 * with the example AUTH_SECRET verifies perfectly, so the failure is silent,
 * total, and only visible to whoever read the repository. It has to stop the
 * deployment coming up at all.
 *
 * env.ts builds its object at import, so each case resets the module registry
 * and imports it again.
 */

const EXAMPLE_AUTH_SECRET = "dev-only-secret-change-me-to-something-long-and-random";
const REAL_SECRET = "PxT2qv8nR4wKfL9dYbA3sZmE7hJ6uC1oNgV5tXrQi0k";
const REAL_KEY = "00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff";

async function loadEnv(vars: Record<string, string>) {
  vi.resetModules();
  vi.stubEnv("DATABASE_URL", "postgresql://u:p@localhost:5433/db");
  vi.stubEnv("AUTH_SECRET", REAL_SECRET);
  vi.stubEnv("SECRETS_KEY", REAL_KEY);
  vi.stubEnv("SCHEDULE_TOKEN", "");
  vi.stubEnv("N8N_SYNC_TOKEN", "");
  vi.stubEnv("NEXT_PHASE", "");
  for (const [key, value] of Object.entries(vars)) vi.stubEnv(key, value);

  return import("@/lib/env");
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

describe("in production", () => {
  it("refuses the example AUTH_SECRET", async () => {
    await expect(
      loadEnv({ NODE_ENV: "production", AUTH_SECRET: EXAMPLE_AUTH_SECRET }),
    ).rejects.toThrow(/AUTH_SECRET is still the value from \.env\.example/);
  });

  it("refuses a short AUTH_SECRET", async () => {
    await expect(
      loadEnv({ NODE_ENV: "production", AUTH_SECRET: "short" }),
    ).rejects.toThrow(/must be at least/);
  });

  it("refuses the example sync token", async () => {
    await expect(
      loadEnv({ NODE_ENV: "production", N8N_SYNC_TOKEN: "dev-sync-token" }),
    ).rejects.toThrow(/N8N_SYNC_TOKEN is still the value/);
  });

  it("refuses the example schedule token", async () => {
    await expect(
      loadEnv({ NODE_ENV: "production", SCHEDULE_TOKEN: "dev-schedule-token" }),
    ).rejects.toThrow(/SCHEDULE_TOKEN is still the value/);
  });

  it("allows an empty token, because empty disables the endpoint", async () => {
    const { env } = await loadEnv({ NODE_ENV: "production", SCHEDULE_TOKEN: "" });
    expect(env.scheduleToken).toBe("");
  });

  it("allows real secrets", async () => {
    const { env } = await loadEnv({
      NODE_ENV: "production",
      SCHEDULE_TOKEN: "a-real-schedule-token-value",
    });

    expect(env.authSecret).toBe(REAL_SECRET);
    expect(env.scheduleToken).toBe("a-real-schedule-token-value");
  });

  it("still refuses a missing secret outright", async () => {
    await expect(
      loadEnv({ NODE_ENV: "production", AUTH_SECRET: "" }),
    ).rejects.toThrow(/Missing AUTH_SECRET/);
  });
});

describe("during a production build", () => {
  /**
   * `next build` runs with NODE_ENV=production and imports every route to
   * collect page data. If the guards fired there, building would require the
   * running deployment's secrets — so the build phase is exempt, and this is
   * the test that says so on purpose rather than by accident.
   */
  it("allows the example values, because none of them is baked into the output", async () => {
    const { env } = await loadEnv({
      NODE_ENV: "production",
      NEXT_PHASE: "phase-production-build",
      AUTH_SECRET: EXAMPLE_AUTH_SECRET,
      SCHEDULE_TOKEN: "dev-schedule-token",
    });

    expect(env.authSecret).toBe(EXAMPLE_AUTH_SECRET);
    expect(env.scheduleToken).toBe("dev-schedule-token");
  });

  it("still refuses a missing secret, which no phase makes optional", async () => {
    await expect(
      loadEnv({
        NODE_ENV: "production",
        NEXT_PHASE: "phase-production-build",
        AUTH_SECRET: "",
      }),
    ).rejects.toThrow(/Missing AUTH_SECRET/);
  });

  it("refuses them again on the boot that follows", async () => {
    // The exemption is the build, not production. Same secrets, no phase.
    await expect(
      loadEnv({ NODE_ENV: "production", AUTH_SECRET: EXAMPLE_AUTH_SECRET }),
    ).rejects.toThrow(/still the value from \.env\.example/);
  });
});

describe("outside production", () => {
  it("allows the example values, which is why they exist", async () => {
    // `cp .env.example .env` has to keep working on a laptop.
    const { env } = await loadEnv({
      NODE_ENV: "development",
      AUTH_SECRET: EXAMPLE_AUTH_SECRET,
      SCHEDULE_TOKEN: "dev-schedule-token",
      N8N_SYNC_TOKEN: "dev-sync-token",
    });

    expect(env.authSecret).toBe(EXAMPLE_AUTH_SECRET);
    expect(env.scheduleToken).toBe("dev-schedule-token");
  });
});
