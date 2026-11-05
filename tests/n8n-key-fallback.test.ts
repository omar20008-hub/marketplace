import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The platform's two n8n keys. The fallback is tried only when n8n refuses the
 * first one, and a refusal of both is reported as "rejected".
 */

vi.hoisted(() => {
  process.env.N8N_DRIVER = "live";
  process.env.N8N_BASE_URL = "https://n8n.test/api/v1";
  process.env.N8N_API_KEY = "primary-key";
  process.env.N8N_API_KEY_FALLBACK = "fallback-key";
});

const { probeN8nApi } = await import("@/lib/n8n/live");

const sent: string[] = [];
function replies(...statuses: number[]) {
  const queue = [...statuses];
  return vi.fn(async (_url: string, init: RequestInit) => {
    sent.push((init.headers as Record<string, string>)["X-N8N-API-KEY"]);
    return new Response("{}", { status: queue.shift() ?? 200 });
  });
}

beforeEach(() => {
  sent.length = 0;
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe("probeN8nApi with two keys", () => {
  it("uses the primary key alone while n8n accepts it", async () => {
    vi.stubGlobal("fetch", replies(200));
    expect(await probeN8nApi()).toBe("ok");
    expect(sent).toEqual(["primary-key"]);
  });

  it("falls back to the second key only when the first is refused", async () => {
    vi.stubGlobal("fetch", replies(401, 200));
    expect(await probeN8nApi()).toBe("ok");
    expect(sent).toEqual(["primary-key", "fallback-key"]);
  });

  it("reports rejected when both keys are refused", async () => {
    vi.stubGlobal("fetch", replies(401, 401));
    expect(await probeN8nApi()).toBe("rejected");
  });

  it("reports unreachable when n8n cannot be reached at all", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => {
      throw new Error("network down");
    }));
    expect(await probeN8nApi()).toBe("unreachable");
  });
});
