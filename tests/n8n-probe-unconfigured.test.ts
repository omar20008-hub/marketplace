import { describe, expect, it, vi } from "vitest";

/**
 * With no n8n REST address or key on the platform there is nothing to check. That is
 * a choice (the key is full control of n8n), so it is reported as "unconfigured",
 * not as a fault, and no request is sent.
 */

vi.hoisted(() => {
  process.env.N8N_DRIVER = "live";
  process.env.N8N_BASE_URL = "";
  process.env.N8N_API_KEY = "";
  process.env.N8N_API_KEY_FALLBACK = "";
});

const { probeN8nApi } = await import("@/lib/n8n/live");

describe("probeN8nApi without REST settings", () => {
  it("reports unconfigured and sends nothing", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    expect(await probeN8nApi()).toBe("unconfigured");
    expect(fetchSpy).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });
});
