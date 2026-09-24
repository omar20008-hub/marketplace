import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * Which driver the platform loads.
 *
 * Three lines of code, and the only place the decision is made. It is worth a
 * test because getting it wrong is silent in the worst direction: a deployment
 * set to `live` that quietly kept the mock would answer every screen correctly,
 * with green badges and plausible run output, while nothing at all reached n8n.
 * Nobody would notice until someone asked where their file went.
 *
 * lib/n8n/index.ts picks at module load, so each case resets the registry.
 */

async function loadWith(driver: string) {
  vi.resetModules();
  vi.stubEnv("N8N_DRIVER", driver);
  return import("@/lib/n8n");
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

describe("N8N_DRIVER", () => {
  it("loads the live driver when it says live", async () => {
    const { n8n } = await loadWith("live");
    const { liveDriver } = await import("@/lib/n8n/live");

    expect(n8n).toBe(liveDriver);
  });

  it("loads the mock when it says mock", async () => {
    const { n8n } = await loadWith("mock");
    const { mockDriver } = await import("@/lib/n8n/mock");

    expect(n8n).toBe(mockDriver);
  });

  it("falls back to the mock for a value it does not recognise", async () => {
    // Failing closed the other way would send a typo's worth of traffic at a
    // real n8n instance with real credentials on it.
    const { n8n } = await loadWith("liv");
    const { mockDriver } = await import("@/lib/n8n/mock");

    expect(n8n).toBe(mockDriver);
  });

  it("offers the same shape either way", async () => {
    // Everything downstream is written against one interface; a driver missing
    // a method would fail at the moment someone used that feature, not at boot.
    const live = (await loadWith("live")).n8n;
    const mock = (await loadWith("mock")).n8n;

    expect(Object.keys(live).sort()).toEqual(Object.keys(mock).sort());
  });

  it("re-exports the contracts, which is what the rest of the code imports", async () => {
    const loaded = await loadWith("mock");

    expect(typeof loaded.splitList).toBe("function");
  });
});
