import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * When the platform itself fails (a database error, say), the endpoint must still answer
 * as JSON-RPC, say nothing about the cause, and not leave its per-person counter stuck.
 * The gateway module is replaced here, so no database is involved.
 */

const gateway = vi.hoisted(() => ({ handle: vi.fn() }));
vi.mock("@/server/mcp-gateway", () => ({ handleRpc: gateway.handle }));
vi.mock("@/server/agent-keys", () => ({
  bearerToken: (request: Request) => /^Bearer\s+(\S+)$/.exec(request.headers.get("authorization") ?? "")?.[1] ?? "",
  userForAgentKey: async (key: string) => (key === "ak_good" ? "user-1" : null),
}));
vi.mock("@/server/knowledge/keys", () => ({ installationForKey: async () => null }));

const { POST } = await import("@/app/api/mcp/route");

const ask = () =>
  POST(
    new Request("https://app.example.test/api/mcp", {
      method: "POST",
      headers: { authorization: "Bearer ak_good", "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 4, method: "tools/list" }),
    }),
  );

describe("when the platform fails", () => {
  beforeEach(() => {
    gateway.handle.mockReset();
    vi.spyOn(console, "error").mockImplementation(() => undefined);
  });

  it("answers with a JSON-RPC error and no detail, not a bare 500", async () => {
    gateway.handle.mockRejectedValueOnce(new Error("db down: password=hunter2"));
    const response = await ask();
    expect(response.status).toBe(500);
    const body = await response.json();
    expect(body).toMatchObject({ jsonrpc: "2.0", id: 4, error: { code: -32603 } });
    expect(JSON.stringify(body)).not.toContain("hunter2");
  });

  it("does not stay counted as running, so the person can ask again", async () => {
    for (let i = 0; i < 20; i++) {
      gateway.handle.mockRejectedValueOnce(new Error("boom"));
      expect((await ask()).status).toBe(500);
    }
    gateway.handle.mockResolvedValueOnce({ result: { tools: [] } });
    expect((await ask()).status).toBe(200);
  });
});
