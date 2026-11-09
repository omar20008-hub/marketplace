import { NextResponse } from "next/server";
import { hit } from "@/lib/rate-limit";
import { bearerToken, userForAgentKey } from "@/server/agent-keys";
import { installationForKey } from "@/server/knowledge/keys";
import { handleRpc, type RpcRequest } from "@/server/mcp-gateway";

/**
 * The platform's MCP endpoint (Streamable HTTP). An agent or workflow connects here
 * and gets the tools of the MCP servers its owner connected. Two keys open it, both
 * naming the person and nothing else: the person's agent key (ak_…), for an agent
 * that is theirs, and an installation's key (kb_…), for a workflow built from a
 * product they installed. See docs/mcp-gateway.md.
 *
 * One JSON-RPC message per POST, answered as JSON. There is no server-initiated
 * stream and no session: each call stands alone, so GET and DELETE are not offered.
 */

const MAX_BODY_BYTES = 1024 * 1024;

function rpcError(id: RpcRequest["id"], code: number, message: string, status = 200) {
  return NextResponse.json({ jsonrpc: "2.0", id: id ?? null, error: { code, message } }, { status });
}

/** The person a request is for, from whichever key it carries, or null. */
async function personFor(request: Request): Promise<string | null> {
  const token = bearerToken(request);
  if (token.startsWith("ak_")) return userForAgentKey(token);
  const installation = await installationForKey(request.headers.get("authorization"));
  return installation?.userId ?? null;
}

export async function POST(request: Request) {
  const userId = await personFor(request);
  if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const limiter = hit(`mcp-gateway:${userId}`, { limit: 300, windowMs: 60_000 });
  if (!limiter.ok) {
    return NextResponse.json(
      { error: "Too many requests" },
      { status: 429, headers: { "retry-after": String(limiter.retryAfterSeconds) } },
    );
  }

  const text = await request.text();
  if (text.length > MAX_BODY_BYTES) return rpcError(null, -32600, "The request is too large.", 413);

  let message: unknown;
  try {
    message = JSON.parse(text);
  } catch {
    return rpcError(null, -32700, "The body must be JSON.", 400);
  }
  // Batching was dropped from the protocol; one message at a time.
  if (!message || typeof message !== "object" || Array.isArray(message)) {
    return rpcError(null, -32600, "Send one JSON-RPC message per request.", 400);
  }

  const rpc = message as Partial<RpcRequest>;
  if (rpc.jsonrpc !== "2.0" || typeof rpc.method !== "string") {
    // A response or a malformed message: nothing for us to answer.
    return rpcError(rpc.id, -32600, "Not a JSON-RPC 2.0 request.", 400);
  }

  const outcome = await handleRpc(userId, rpc as RpcRequest);
  // A notification gets no body, as the transport says.
  if (!outcome) return new NextResponse(null, { status: 202 });

  return NextResponse.json(
    { jsonrpc: "2.0", id: rpc.id ?? null, ...outcome },
    { headers: { "cache-control": "no-store" } },
  );
}

export async function GET() {
  return new NextResponse(null, { status: 405, headers: { allow: "POST" } });
}

export async function DELETE() {
  return new NextResponse(null, { status: 405, headers: { allow: "POST" } });
}

export const dynamic = "force-dynamic";
