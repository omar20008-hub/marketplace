import { assertPublicHttpsUrl, UnsafeUrlError } from "./safe-url";

/**
 * A small MCP client over Streamable HTTP, for the servers people connect.
 *
 * Each use is its own short session: initialize, say we are ready, ask one thing,
 * close. That costs a few round trips but keeps nothing alive between calls, so
 * there is no session to expire or to share between people. The protocol's
 * details are the spec's (modelcontextprotocol.io, "Transports"): a request is a
 * POST of one JSON-RPC message, and the answer is either JSON or a stream of
 * server-sent events carrying it.
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

export class McpError extends Error {
  constructor(
    message: string,
    readonly code: "unsafe" | "unreachable" | "unauthorized" | "protocol" | "too_large" | "timeout",
  ) {
    super(message);
    this.name = "McpError";
  }
}

const CLIENT_INFO = { name: "builder-platform", version: "1.0.0" };
/** Newest first. The server answers with the one it speaks; we continue with that. */
export const SUPPORTED_PROTOCOLS = ["2025-06-18", "2025-03-26", "2024-11-05"] as const;
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const MAX_TOOLS = 200;
const MAX_PAGES = 10;

const TIMEOUTS = { handshake: 15_000, list: 20_000, call: 60_000 } as const;

type JsonRpcMessage = {
  jsonrpc: "2.0";
  id?: number | string | null;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
};

/** The body, read up to a limit, so a hostile server cannot make us buffer without end. */
async function readCapped(response: Response): Promise<string> {
  const length = Number(response.headers.get("content-length"));
  if (length > MAX_RESPONSE_BYTES) throw new McpError("The server's answer is too large.", "too_large");
  if (!response.body) return "";

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_RESPONSE_BYTES) {
      await reader.cancel().catch(() => undefined);
      throw new McpError("The server's answer is too large.", "too_large");
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString("utf8");
}

/** The JSON-RPC message with this id, from a JSON body or an event stream. */
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
        // A comment or a malformed event: not the answer.
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

type Session = {
  call: (method: string, params?: unknown, timeoutMs?: number) => Promise<unknown>;
  close: () => Promise<void>;
};

async function send(
  server: McpServer,
  body: unknown,
  headers: Record<string, string>,
  timeoutMs: number,
  method: "POST" | "DELETE" = "POST",
): Promise<Response> {
  try {
    await assertPublicHttpsUrl(server.url);
  } catch (error) {
    if (error instanceof UnsafeUrlError) throw new McpError("That address cannot be used.", "unsafe");
    throw error;
  }

  const all: Record<string, string> = { ...headers };
  if (server.bearer) all.authorization = `Bearer ${server.bearer}`;
  try {
    return await fetch(server.url, {
      method,
      headers: all,
      body: method === "POST" ? JSON.stringify(body) : undefined,
      // A public name must not be able to send us somewhere private.
      redirect: "error",
      cache: "no-store",
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (error) {
    if (error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError")) {
      throw new McpError("The server took too long to answer.", "timeout");
    }
    throw new McpError("The server could not be reached.", "unreachable");
  }
}

function failFor(response: Response): McpError {
  if (response.status === 401 || response.status === 403) {
    return new McpError("The server did not accept the access token.", "unauthorized");
  }
  if (response.status === 404 || response.status === 405 || response.status === 415) {
    return new McpError("That address did not answer as an MCP server.", "protocol");
  }
  return new McpError(`The server answered ${response.status}.`, "unreachable");
}

/** Opens a session, runs `run`, and closes it whatever happened. */
export async function withSession<T>(server: McpServer, run: (session: Session) => Promise<T>): Promise<T> {
  let nextId = 1;
  let sessionId: string | null = null;
  let protocol: string = SUPPORTED_PROTOCOLS[0];
  let initialized = false;

  const baseHeaders = (): Record<string, string> => {
    const headers: Record<string, string> = {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
    };
    if (sessionId) headers["mcp-session-id"] = sessionId;
    // Named on every request after the handshake, as the spec asks, never on the handshake itself.
    if (initialized) headers["mcp-protocol-version"] = protocol;
    return headers;
  };

  const call: Session["call"] = async (method, params, timeoutMs = TIMEOUTS.list) => {
    const id = nextId++;
    const response = await send(
      server,
      { jsonrpc: "2.0", id, method, ...(params === undefined ? {} : { params }) },
      baseHeaders(),
      timeoutMs,
    );
    if (!response.ok) {
      await response.body?.cancel().catch(() => undefined);
      throw failFor(response);
    }
    const text = await readCapped(response);
    const message = messageFor(text, response.headers.get("content-type") ?? "", id);
    if (message.error) throw new McpError(message.error.message || "The server reported an error.", "protocol");

    if (method === "initialize") {
      sessionId = response.headers.get("mcp-session-id");
      const negotiated = (message.result as { protocolVersion?: unknown } | undefined)?.protocolVersion;
      if (typeof negotiated === "string") protocol = negotiated;
      initialized = true;
    }
    return message.result;
  };

  await call(
    "initialize",
    { protocolVersion: SUPPORTED_PROTOCOLS[0], capabilities: {}, clientInfo: CLIENT_INFO },
    TIMEOUTS.handshake,
  );
  const ready = await send(server, { jsonrpc: "2.0", method: "notifications/initialized" }, baseHeaders(), TIMEOUTS.handshake);
  await ready.body?.cancel().catch(() => undefined);
  if (!ready.ok) throw failFor(ready);

  const close = async () => {
    if (!sessionId) return;
    // Best effort: the session is ours to end, and a server that refuses is no worse off.
    const response = await send(server, undefined, baseHeaders(), 5_000, "DELETE").catch(() => null);
    await response?.body?.cancel().catch(() => undefined);
  };

  try {
    return await run({ call, close });
  } finally {
    await close();
  }
}

/** Every tool the server offers, following its pages, up to a sensible bound. */
export async function listTools(server: McpServer): Promise<McpTool[]> {
  return withSession(server, async (session) => {
    const tools: McpTool[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < MAX_PAGES; page++) {
      const result = (await session.call("tools/list", cursor ? { cursor } : {}, TIMEOUTS.list)) as {
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

export async function callTool(
  server: McpServer,
  name: string,
  args: unknown,
): Promise<McpCallResult> {
  return withSession(server, async (session) => {
    const result = await session.call("tools/call", { name, arguments: args ?? {} }, TIMEOUTS.call);
    if (!result || typeof result !== "object") throw new McpError("The tool's answer was not understood.", "protocol");
    return result as McpCallResult;
  });
}
