import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The guest chat endpoint.
 *
 * No session anywhere in this request — that is the point, and the thing
 * worth pinning down. sessionId comes from whoever is calling, so the one
 * property this route cannot get wrong is that the id it actually hands the
 * Orchestrator is never that value: it is always behind a fixed "guest:"
 * prefix, which is what makes a browser-supplied id unable to collide with a
 * real user's (a cuid, which this prefix cannot be) no matter what a caller
 * sends.
 */

const askOrchestratorCalls: { sessionId: string; chatInput: string }[] = [];
vi.mock("@/server/run-engine", () => ({
  askOrchestrator: async (sessionId: string, chatInput: string) => {
    askOrchestratorCalls.push({ sessionId, chatInput });
    return `answered ${chatInput}`;
  },
}));

const { POST } = await import("@/app/api/guest/chat/route");
const { resetAll } = await import("@/lib/rate-limit");

function call(body: unknown, headers: Record<string, string> = {}) {
  return new Request("http://localhost/api/guest/chat", {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

beforeEach(() => {
  askOrchestratorCalls.length = 0;
  resetAll();
});

afterEach(() => {
  resetAll();
});

describe("valid input", () => {
  it("returns the orchestrator's reply", async () => {
    const response = await POST(call({ sessionId: "abc123", message: "hi" }));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ output: "answered hi" });
  });

  it("never sends the caller's own sessionId to the orchestrator", async () => {
    await POST(call({ sessionId: "some-users-real-id", message: "hi" }));

    expect(askOrchestratorCalls).toEqual([
      { sessionId: "guest:some-users-real-id", chatInput: "hi" },
    ]);
  });

  it("prefixes distinct client ids into distinct guest sessions", async () => {
    await POST(call({ sessionId: "tab-a", message: "one" }));
    await POST(call({ sessionId: "tab-b", message: "two" }));

    expect(askOrchestratorCalls.map((c) => c.sessionId)).toEqual([
      "guest:tab-a",
      "guest:tab-b",
    ]);
  });

  it("trims the message before sending it", async () => {
    await POST(call({ sessionId: "abc123", message: "  hi  " }));

    expect(askOrchestratorCalls[0].chatInput).toBe("hi");
  });
});

describe("validation", () => {
  it("refuses invalid JSON", async () => {
    const response = await POST(call("not json"));
    expect(response.status).toBe(400);
    expect(askOrchestratorCalls).toHaveLength(0);
  });

  it("refuses a missing sessionId", async () => {
    const response = await POST(call({ message: "hi" }));
    expect(response.status).toBe(400);
  });

  it("refuses an empty sessionId", async () => {
    const response = await POST(call({ sessionId: "", message: "hi" }));
    expect(response.status).toBe(400);
  });

  it("refuses a sessionId over the length floor", async () => {
    const response = await POST(
      call({ sessionId: "x".repeat(200), message: "hi" }),
    );
    expect(response.status).toBe(400);
  });

  it("refuses an empty message", async () => {
    const response = await POST(call({ sessionId: "abc123", message: "   " }));
    expect(response.status).toBe(400);
    expect(askOrchestratorCalls).toHaveLength(0);
  });

  it("refuses a missing message", async () => {
    const response = await POST(call({ sessionId: "abc123" }));
    expect(response.status).toBe(400);
  });

  it("refuses a message over the length limit", async () => {
    const response = await POST(
      call({ sessionId: "abc123", message: "x".repeat(4001) }),
    );
    expect(response.status).toBe(400);
    expect(askOrchestratorCalls).toHaveLength(0);
  });

  it("accepts a message right at the length limit", async () => {
    const response = await POST(
      call({ sessionId: "abc123", message: "x".repeat(4000) }),
    );
    expect(response.status).toBe(200);
  });
});

describe("rate limiting", () => {
  it("cuts off one session after its own budget, without touching another", async () => {
    for (let i = 0; i < 20; i++) {
      const response = await POST(call({ sessionId: "flooder", message: `m${i}` }));
      expect(response.status).toBe(200);
    }

    const blocked = await POST(call({ sessionId: "flooder", message: "one more" }));
    expect(blocked.status).toBe(429);

    const other = await POST(call({ sessionId: "someone-else", message: "hi" }));
    expect(other.status).toBe(200);
  });

  it("cuts off an address that keeps minting fresh session ids", async () => {
    const headers = { "x-forwarded-for": "203.0.113.5" };

    for (let i = 0; i < 60; i++) {
      const response = await POST(
        call({ sessionId: `fresh-${i}`, message: "hi" }, headers),
      );
      expect(response.status).toBe(200);
    }

    const blocked = await POST(
      call({ sessionId: "fresh-60", message: "hi" }, headers),
    );
    expect(blocked.status).toBe(429);

    // A different address is unaffected.
    const other = await POST(
      call({ sessionId: "fresh-61", message: "hi" }, { "x-forwarded-for": "198.51.100.1" }),
    );
    expect(other.status).toBe(200);
  });

  it("does not throw when x-forwarded-for is absent", async () => {
    const response = await POST(call({ sessionId: "no-header", message: "hi" }));
    expect(response.status).toBe(200);
  });
});
