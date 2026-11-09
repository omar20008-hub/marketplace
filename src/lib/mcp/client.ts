import { assertPublicHttpsUrl, UnsafeUrlError } from "./safe-url";
import { McpError } from "./errors";
import { transport, type TransportResponse } from "./transport";

export { McpError };

/**
 * A small MCP client over Streamable HTTP, for the servers people connect.
 *
 * Each use is its own short session: initialize, say we are ready, ask one thing,
 * close. That costs a few round trips but keeps nothing alive between calls, so
 * there is no session to expire or to share between people. The protocol's
 * details are the spec's (modelcontextprotocol.io, "Transports"): a request is a
 * POST of one JSON-RPC message, and the answer is either JSON or a stream of
 * server-sent events carrying it.
 *
 * A session has one time budget for all of its requests, so a slow server costs a
 * bounded amount however many pages or round trips it makes us take.
 */

export type McpServer = { url: string; bearer?: string };

export type McpTool = {
  name: string;
  description?: string;
  inputSchema?: unknown;
  title?: string;
  annotations?: unknown;
};

export type McpCallResult = {
  content?: unknown[];
  structuredContent?: unknown;
  isError?: boolean;
};

const CLIENT_INFO = { name: "builder-platform", version: "1.0.0" };
/** Newest first. The server answers with the one it speaks; we continue with that, if we know it. */
export const SUPPORTED_PROTOCOLS = ["2025-06-18", "2025-03-26", "2024-11-05"] as const;
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const MAX_TOOLS = 200;
const MAX_PAGES = 5;

/** Whole-session budgets, and the most any one request may take. */
const BUDGET = { list: 25_000, call: 65_000 } as const;
const REQUEST_CAP = { handshake: 10_000, page: 15_000, close: 5_000 } as const;

type JsonRpcMessage = {
  jsonrpc: "2.0";
  id?: number | string | null;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
};

/** The JSON-RPC message with this id, from a JSON body or an event stream. Throws if it is not (yet) there. */
function messageFor(text: string, contentType: string, id: number): JsonRpcMessage {
  const candidates: unknown[] = [];
  if (contentType.includes("text/event-stream")) {
    for (const event of text.split(/\r?\n\r?\n/)) {
      const data = event
        .split(/\r?\n/)
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.slice(5).replace(/^ /, ""))
        .join("\n");
      if (!data) continue;
      try {
        candidates.push(JSON.parse(data));
      } catch {
        // A comment, or an event still arriving: not the answer.
      }
    }
  } else {
    try {
      candidates.push(JSON.parse(text));
    } catch {
      throw new McpError("That address did not answer as an MCP server.", "protocol");
    }
  }

  for (const candidate of candidates.flat()) {
    const message = candidate as JsonRpcMessage;
    if (message && message.jsonrpc === "2.0" && message.id === id && ("result" in message || "error" in message)) {
      return message;
    }
  }
  throw new McpError("The server did not answer the request.", "protocol");
}

function failFor(status: number): McpError {
  if (status === 401) return new McpError("The server did not accept the access token.", "unauthorized");
  if (status === 403) return new McpError("The server refused access with that token.", "forbidden");
  if (status === 404 || status === 405 || status === 415) {
    return new McpError("That address did not answer as an MCP server.", "protocol");
  }
  return new McpError(`The server answered ${status}.`, "unreachable");
}

const ok = (response: TransportResponse) => response.status >= 200 && response.status < 300;

type Session = {
  call: (method: string, params?: unknown, capMs?: number) => Promise<unknown>;
};

/** Opens a session within `budgetMs`, runs `run`, and closes it whatever happened. */
export async function withSession<T>(
  server: McpServer,
  budgetMs: number,
  run: (session: Session) => Promise<T>,
): Promise<T> {
  const deadline = Date.now() + budgetMs;
  let nextId = 1;
  let sessionId: string | null = null;
  let protocol: string = SUPPORTED_PROTOCOLS[0];
  let initialized = false;

  const headers = (): Record<string, string> => {
    const all: Record<string, string> = {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
    };
    if (server.bearer) all.authorization = `Bearer ${server.bearer}`;
    if (sessionId) all["mcp-session-id"] = sessionId;
    // Named on every request after the handshake, as the spec asks, never on the handshake itself.
    if (initialized) all["mcp-protocol-version"] = protocol;
    return all;
  };

  async function post(
    method: "POST" | "DELETE",
    body: unknown,
    capMs: number,
    until?: (text: string) => boolean,
  ): Promise<TransportResponse> {
    let url: URL;
    try {
      url = await assertPublicHttpsUrl(server.url);
    } catch (error) {
      if (error instanceof UnsafeUrlError) throw new McpError("That address cannot be used.", "unsafe");
      throw error;
    }
    const timeoutMs = Math.min(capMs, deadline - Date.now());
    if (timeoutMs <= 0) throw new McpError("The server took too long to answer.", "timeout");
    return transport.send({
      url,
      method,
      headers: headers(),
      body: method === "POST" ? JSON.stringify(body) : undefined,
      timeoutMs,
      maxBytes: MAX_RESPONSE_BYTES,
      until: until ? (text) => until(text) : undefined,
    });
  }

  const call: Session["call"] = async (method, params, capMs = REQUEST_CAP.page) => {
    const id = nextId++;
    const response = await post(
      "POST",
      { jsonrpc: "2.0", id, method, ...(params === undefined ? {} : { params }) },
      capMs,
      // An event stream may stay open after it has answered; stop as soon as our answer is in.
      (text) => {
        try {
          messageFor(text, "text/event-stream", id);
          return true;
        } catch {
          return false;
        }
      },
    );
    if (!ok(response)) throw failFor(response.status);
    const message = messageFor(response.text, response.headers["content-type"] ?? "", id);
    if (message.error) throw new McpError(message.error.message || "The server reported an error.", "protocol");

    if (method === "initialize") {
      const negotiated = (message.result as { protocolVersion?: unknown } | undefined)?.protocolVersion;
      if (typeof negotiated !== "string" || !(SUPPORTED_PROTOCOLS as readonly string[]).includes(negotiated)) {
        throw new McpError("The server speaks a protocol version this platform does not support.", "protocol");
      }
      protocol = negotiated;
      sessionId = response.headers["mcp-session-id"] ?? null;
      initialized = true;
    }
    return message.result;
  };

  await call(
    "initialize",
    { protocolVersion: SUPPORTED_PROTOCOLS[0], capabilities: {}, clientInfo: CLIENT_INFO },
    REQUEST_CAP.handshake,
  );
  const ready = await post("POST", { jsonrpc: "2.0", method: "notifications/initialized" }, REQUEST_CAP.handshake);
  if (!ok(ready)) throw failFor(ready.status);

  try {
    return await run({ call });
  } finally {
    if (sessionId) {
      // Best effort, and outside the budget: the session is ours to end, and a
      // server that refuses is no worse off.
      await transport
        .send({
          url: new URL(server.url),
          method: "DELETE",
          headers: headers(),
          timeoutMs: REQUEST_CAP.close,
          maxBytes: 4096,
        })
        .catch(() => undefined);
    }
  }
}

/** Every tool the server offers, following its pages, up to a sensible bound. */
export async function listTools(server: McpServer): Promise<McpTool[]> {
  return withSession(server, BUDGET.list, async (session) => {
    const tools: McpTool[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < MAX_PAGES; page++) {
      const result = (await session.call("tools/list", cursor ? { cursor } : {})) as {
        tools?: unknown;
        nextCursor?: unknown;
      };
      if (!Array.isArray(result?.tools)) throw new McpError("The server's tool list was not understood.", "protocol");
      for (const tool of result.tools as McpTool[]) {
        if (tool && typeof tool.name === "string") tools.push(tool);
      }
      if (tools.length >= MAX_TOOLS) return tools.slice(0, MAX_TOOLS);
      if (typeof result.nextCursor !== "string" || !result.nextCursor) break;
      cursor = result.nextCursor;
    }
    return tools;
  });
}

export async function callTool(server: McpServer, name: string, args: unknown): Promise<McpCallResult> {
  return withSession(server, BUDGET.call, async (session) => {
    const result = await session.call("tools/call", { name, arguments: args ?? {} }, BUDGET.call);
    if (!result || typeof result !== "object") throw new McpError("The tool's answer was not understood.", "protocol");
    return result as McpCallResult;
  });
}
