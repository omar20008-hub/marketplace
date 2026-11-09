import { afterEach, describe, expect, it, vi } from "vitest";
import { isPrivateAddress, assertPublicHttpsUrl, UnsafeUrlError } from "@/lib/mcp/safe-url";
import {
  aliasFor,
  assignAliases,
  namespacedName,
  splitNamespacedName,
} from "@/lib/mcp/naming";
import { callTool, listTools, McpError, type McpServer } from "@/lib/mcp/client";

describe("which addresses may be connected", () => {
  it.each([
    "127.0.0.1",
    "10.0.0.5",
    "172.16.0.1",
    "172.31.255.255",
    "192.168.1.1",
    "169.254.169.254", // the cloud metadata service
    "100.64.0.1", // carrier-grade NAT
    "0.0.0.0",
    "224.0.0.1",
    "255.255.255.255",
    "::",
    "::1",
    "fe80::1",
    "fc00::1",
    "fd12:3456::1",
    "ff02::1",
    "::ffff:10.0.0.1", // IPv4 hidden inside an IPv6 address
    "::ffff:7f00:1",
    "64:ff9b::a00:1", // NAT64 around 10.0.0.1
    "2002:7f00:1::", // 6to4 around 127.0.0.1
    "2001:db8::1",
    "not-an-address",
  ])("refuses %s", (address) => {
    expect(isPrivateAddress(address)).toBe(true);
  });

  it.each(["93.184.216.34", "8.8.8.8", "172.32.0.1", "2606:4700:4700::1111", "2001:4860:4860::8888"])(
    "allows the public address %s",
    (address) => {
      expect(isPrivateAddress(address)).toBe(false);
    },
  );

  const publicName = async () => ["93.184.216.34"];

  it("accepts an https address on a public name", async () => {
    const url = await assertPublicHttpsUrl("https://mcp.example.com/mcp", publicName);
    expect(url.pathname).toBe("/mcp");
  });

  it.each([
    ["http://mcp.example.com/mcp", "scheme"],
    ["ftp://mcp.example.com/mcp", "scheme"],
    ["not a url", "scheme"],
    ["https://user:pass@mcp.example.com/mcp", "credentials"],
    ["https://mcp.example.com/mcp?token=abc", "query"],
    ["https://mcp.example.com/mcp#frag", "query"],
    ["https://mcp.example.com:8443/mcp", "port"],
    ["https://localhost/mcp", "host"],
    ["https://db.railway.internal/mcp", "host"],
    ["https://printer.local/mcp", "host"],
    ["https://169.254.169.254/latest/meta-data", "private"],
    ["https://[::1]/mcp", "private"],
    ["https://10.1.2.3/mcp", "private"],
  ])("refuses %s (%s)", async (address, reason) => {
    await expect(assertPublicHttpsUrl(address, publicName)).rejects.toMatchObject({ reason });
  });

  it("refuses a public-looking name that resolves to a private address, or to any private one", async () => {
    await expect(assertPublicHttpsUrl("https://sneaky.example.com/mcp", async () => ["10.0.0.9"])).rejects.toMatchObject({
      reason: "private",
    });
    await expect(
      assertPublicHttpsUrl("https://mixed.example.com/mcp", async () => ["93.184.216.34", "127.0.0.1"]),
    ).rejects.toMatchObject({ reason: "private" });
  });

  it("refuses a name that does not resolve", async () => {
    await expect(
      assertPublicHttpsUrl("https://nowhere.example.com/mcp", async () => {
        throw new Error("ENOTFOUND");
      }),
    ).rejects.toBeInstanceOf(UnsafeUrlError);
    await expect(assertPublicHttpsUrl("https://empty.example.com/mcp", async () => [])).rejects.toMatchObject({
      reason: "unresolved",
    });
  });
});

describe("naming tools across servers", () => {
  it("makes a short lowercase alias that never contains a double underscore", () => {
    expect(aliasFor("n8n")).toBe("n8n");
    expect(aliasFor("My Notion — Work!")).toBe("my_notion_work");
    expect(aliasFor("a__b")).toBe("a_b");
    expect(aliasFor("!!!")).toBe("server");
    expect(aliasFor("x".repeat(60)).length).toBeLessThanOrEqual(20);
  });

  it("keeps the plain alias for the oldest server and numbers the later ones", () => {
    const aliases = assignAliases([
      { id: "1", displayName: "n8n" },
      { id: "2", displayName: "N8N" },
      { id: "3", displayName: "Notion" },
      { id: "4", displayName: "n8n" },
    ]);
    expect([...aliases.values()]).toEqual(["n8n", "n8n_2", "notion", "n8n_3"]);
  });

  it("joins and splits a tool name, with the tool's own double underscores intact", () => {
    expect(namespacedName("n8n", "search")).toBe("n8n__search");
    const name = namespacedName("notion", "pages__create")!;
    expect(splitNamespacedName(name)).toEqual({ alias: "notion", tool: "pages__create" });
  });

  it("refuses a tool name that clients would reject", () => {
    expect(namespacedName("n8n", "has space")).toBeNull();
    expect(namespacedName("n8n", "x".repeat(70))).toBeNull();
    expect(splitNamespacedName("nodelimiter")).toBeNull();
    expect(splitNamespacedName("__tool")).toBeNull();
    expect(splitNamespacedName("alias__")).toBeNull();
  });
});

// ------------------------------------------------------------------ client

type Seen = { method: string; headers: Record<string, string>; body: unknown };

/** An in-memory MCP server behind a stubbed fetch, recording what it was sent. */
function fakeServer(options: {
  sse?: boolean;
  session?: string;
  status?: number;
  tools?: { name: string }[][];
  rpcError?: string;
  toolResult?: unknown;
  protocol?: string;
}) {
  const seen: Seen[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_url: string, init: { method: string; headers: Record<string, string>; body?: string }) => {
      const body = init.body ? JSON.parse(init.body) : undefined;
      seen.push({ method: init.method, headers: init.headers, body });
      if (options.status && options.status !== 200) return new Response("no", { status: options.status });
      if (init.method === "DELETE") return new Response(null, { status: 204 });
      if (body && body.id === undefined) return new Response(null, { status: 202 });

      let result: unknown;
      if (body.method === "initialize") {
        result = { protocolVersion: options.protocol ?? "2025-06-18", capabilities: {}, serverInfo: { name: "fake" } };
      } else if (body.method === "tools/list") {
        const pages = options.tools ?? [[]];
        const index = body.params?.cursor ? Number(body.params.cursor) : 0;
        result = { tools: pages[index], ...(index + 1 < pages.length ? { nextCursor: String(index + 1) } : {}) };
      } else if (body.method === "tools/call") {
        result = options.toolResult ?? { content: [{ type: "text", text: "done" }] };
      }
      const message = options.rpcError
        ? { jsonrpc: "2.0", id: body.id, error: { code: -32000, message: options.rpcError } }
        : { jsonrpc: "2.0", id: body.id, result };

      const headers: Record<string, string> = {};
      if (options.session && body.method === "initialize") headers["mcp-session-id"] = options.session;
      if (options.sse) {
        headers["content-type"] = "text/event-stream";
        const noise = `: keep-alive\n\nevent: message\ndata: ${JSON.stringify({ jsonrpc: "2.0", method: "notifications/progress" })}\n\n`;
        return new Response(`${noise}event: message\ndata: ${JSON.stringify(message)}\n\n`, { headers });
      }
      headers["content-type"] = "application/json";
      return new Response(JSON.stringify(message), { headers });
    }),
  );
  return seen;
}

// A public IP literal, so the address check needs no DNS.
const SERVER: McpServer = { url: "https://93.184.216.34/mcp", bearer: "secret-token" };

describe("the MCP client", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("greets the server, says it is ready, lists tools, and sends the token on every request", async () => {
    const seen = fakeServer({ tools: [[{ name: "search" }, { name: "create" }]] });
    const tools = await listTools(SERVER);

    expect(tools.map((t) => t.name)).toEqual(["search", "create"]);
    expect(seen.map((s) => s.body && (s.body as { method: string }).method)).toEqual([
      "initialize",
      "notifications/initialized",
      "tools/list",
    ]);
    for (const request of seen) expect(request.headers.authorization).toBe("Bearer secret-token");
    expect(seen[0].headers.accept).toContain("text/event-stream");
  });

  it("names the protocol version only after the handshake, using the one the server chose", async () => {
    const seen = fakeServer({ tools: [[]], protocol: "2025-03-26" });
    await listTools(SERVER);
    expect(seen[0].headers["mcp-protocol-version"]).toBeUndefined();
    expect(seen[1].headers["mcp-protocol-version"]).toBe("2025-03-26");
    expect(seen[2].headers["mcp-protocol-version"]).toBe("2025-03-26");
  });

  it("carries the session id the server issued, and ends the session when done", async () => {
    const seen = fakeServer({ session: "sess-1", tools: [[{ name: "a" }]] });
    await listTools(SERVER);
    expect(seen[0].headers["mcp-session-id"]).toBeUndefined();
    expect(seen[1].headers["mcp-session-id"]).toBe("sess-1");
    expect(seen[2].headers["mcp-session-id"]).toBe("sess-1");
    const last = seen[seen.length - 1];
    expect(last.method).toBe("DELETE");
    expect(last.headers["mcp-session-id"]).toBe("sess-1");
  });

  it("reads an answer delivered as a server-sent event stream, ignoring other events", async () => {
    fakeServer({ sse: true, tools: [[{ name: "streamed" }]] });
    expect((await listTools(SERVER)).map((t) => t.name)).toEqual(["streamed"]);
  });

  it("follows a tool list across pages", async () => {
    fakeServer({ tools: [[{ name: "one" }], [{ name: "two" }], [{ name: "three" }]] });
    expect((await listTools(SERVER)).map((t) => t.name)).toEqual(["one", "two", "three"]);
  });

  it("calls a tool with its arguments and returns the server's result", async () => {
    const seen = fakeServer({ toolResult: { content: [{ type: "text", text: "42" }], isError: false } });
    const result = await callTool(SERVER, "answer", { q: "life" });
    expect(result.content).toEqual([{ type: "text", text: "42" }]);
    const call = seen.find((s) => (s.body as { method?: string })?.method === "tools/call")!;
    expect(call.body).toMatchObject({ params: { name: "answer", arguments: { q: "life" } } });
  });

  it("says the token was refused on a 401 or 403", async () => {
    fakeServer({ status: 401 });
    await expect(listTools(SERVER)).rejects.toMatchObject({ code: "unauthorized" });
    vi.unstubAllGlobals();
    fakeServer({ status: 403 });
    await expect(listTools(SERVER)).rejects.toMatchObject({ code: "unauthorized" });
  });

  it("says an address is not an MCP server on a 404, and unreachable on a 500", async () => {
    fakeServer({ status: 404 });
    await expect(listTools(SERVER)).rejects.toMatchObject({ code: "protocol" });
    vi.unstubAllGlobals();
    fakeServer({ status: 500 });
    await expect(listTools(SERVER)).rejects.toMatchObject({ code: "unreachable" });
  });

  it("reports a JSON-RPC error from the server", async () => {
    fakeServer({ rpcError: "bad things" });
    await expect(listTools(SERVER)).rejects.toMatchObject({ code: "protocol", message: "bad things" });
  });

  it("does not follow a redirect, and reports an unreachable server", async () => {
    const calls: { redirect?: string }[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init: { redirect?: string }) => {
        calls.push(init);
        throw new TypeError("redirect mode is set to error");
      }),
    );
    await expect(listTools(SERVER)).rejects.toMatchObject({ code: "unreachable" });
    expect(calls[0].redirect).toBe("error");
  });

  it("refuses to connect at all to a private address", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    await expect(listTools({ url: "https://10.0.0.1/mcp" })).rejects.toMatchObject({ code: "unsafe" });
    await expect(listTools({ url: "http://93.184.216.34/mcp" })).rejects.toBeInstanceOf(McpError);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("does not buffer an oversized answer", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("x".repeat(3 * 1024 * 1024), { headers: { "content-type": "application/json" } })),
    );
    await expect(listTools(SERVER)).rejects.toMatchObject({ code: "too_large" });
  });
});
