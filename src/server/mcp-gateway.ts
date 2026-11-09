import "server-only";
import { prisma } from "@/lib/db";
import { openCredential } from "@/lib/secrets";
import { callTool, listTools, McpError, SUPPORTED_PROTOCOLS, type McpServer, type McpTool } from "@/lib/mcp/client";
import { assignAliases, MCP_CREDENTIAL, namespacedName, splitNamespacedName } from "@/lib/mcp/naming";
import { refreshInstallationStates } from "./installation-state";

/**
 * The platform as one MCP server for everything a person has connected.
 *
 * An agent or workflow that speaks MCP (LangGraph, n8n's MCP Client node, Claude)
 * connects here once, with its installation's key, and sees the tools of every
 * MCP server that person connected, named <server>__<tool>. Calls are routed back
 * to the server they belong to, with the person's own credential for it, which the
 * caller never sees.
 *
 * Which servers: the person's own, ACTIVE, and marked for every product ("reusable").
 * A server kept for one product only is not offered through the gateway.
 */

export const GATEWAY_INFO = { name: "builder-platform", version: "1.0.0" };

export type RpcRequest = { jsonrpc: "2.0"; id?: number | string | null; method: string; params?: unknown };
export type RpcOutcome = { result: unknown } | { error: { code: number; message: string } };

// JSON-RPC's own codes, and one of ours for a server that answered badly.
const METHOD_NOT_FOUND = -32601;
const INVALID_PARAMS = -32602;
const SERVER_ERROR = -32000;

const LIST_CACHE_MS = 60_000;
const listCache = new Map<string, { at: number; tools: McpTool[] }>();

/** Replaceable in tests, so no test reaches a real server. */
export const gatewayRuntime = { listTools, callTool };

type Connected = { id: string; displayName: string; alias: string; server: McpServer };

async function connectedServers(userId: string): Promise<Connected[]> {
  const rows = await prisma.connector.findMany({
    where: { userId, credentialType: MCP_CREDENTIAL, status: "ACTIVE", reusable: true },
    orderBy: { createdAt: "asc" },
  });
  const aliases = assignAliases(rows);
  const connected: Connected[] = [];
  for (const row of rows) {
    if (!row.secretJson) continue;
    const secret = openCredential(row.secretJson);
    if (!secret.url) continue;
    connected.push({
      id: row.id,
      displayName: row.displayName,
      alias: aliases.get(row.id)!,
      server: { url: secret.url, bearer: secret.bearer || undefined },
    });
  }
  return connected;
}

async function toolsOf(connected: Connected): Promise<McpTool[]> {
  const cached = listCache.get(connected.id);
  if (cached && Date.now() - cached.at < LIST_CACHE_MS) return cached.tools;
  const tools = await gatewayRuntime.listTools(connected.server);
  listCache.set(connected.id, { at: Date.now(), tools });
  return tools;
}

/** Forgets a server's cached tool list, for when it is connected again or removed. */
export function forgetTools(connectorId: string) {
  listCache.delete(connectorId);
}

/** A server whose token was refused is marked for reconnecting, as any other connection is. */
async function markExpired(userId: string, connectorId: string) {
  await prisma.connector.updateMany({
    where: { id: connectorId, userId, status: "ACTIVE" },
    data: { status: "EXPIRED" },
  });
  forgetTools(connectorId);
  await refreshInstallationStates(userId);
}

async function listAll(userId: string): Promise<RpcOutcome> {
  const servers = await connectedServers(userId);
  const settled = await Promise.allSettled(servers.map(toolsOf));

  const tools: unknown[] = [];
  settled.forEach((outcome, index) => {
    const { alias, displayName } = servers[index];
    if (outcome.status === "rejected") {
      // One server being down must not take the others' tools with it.
      const code = outcome.reason instanceof McpError ? outcome.reason.code : "error";
      console.warn(`MCP gateway: could not list tools for "${alias}": ${code}`);
      return;
    }
    for (const tool of outcome.value) {
      const name = namespacedName(alias, tool.name);
      if (!name) continue;
      tools.push({
        name,
        ...(tool.title ? { title: tool.title } : {}),
        description: `[${displayName}] ${tool.description ?? tool.name}`,
        inputSchema: tool.inputSchema ?? { type: "object", properties: {} },
        ...(tool.annotations ? { annotations: tool.annotations } : {}),
      });
    }
  });
  return { result: { tools } };
}

async function callOne(userId: string, params: unknown): Promise<RpcOutcome> {
  const { name, arguments: args } = (params ?? {}) as { name?: unknown; arguments?: unknown };
  const parts = typeof name === "string" ? splitNamespacedName(name) : null;
  if (!parts) return { error: { code: INVALID_PARAMS, message: "Unknown tool." } };
  if (args !== undefined && (typeof args !== "object" || args === null || Array.isArray(args))) {
    return { error: { code: INVALID_PARAMS, message: "Tool arguments must be an object." } };
  }

  const target = (await connectedServers(userId)).find((s) => s.alias === parts.alias);
  if (!target) return { error: { code: INVALID_PARAMS, message: "Unknown tool." } };

  try {
    return { result: await gatewayRuntime.callTool(target.server, parts.tool, args ?? {}) };
  } catch (error) {
    if (error instanceof McpError) {
      if (error.code === "unauthorized") {
        await markExpired(userId, target.id);
        return {
          error: {
            code: SERVER_ERROR,
            message: `${target.displayName} did not accept its access token. Reconnect it from Connectors.`,
          },
        };
      }
      return { error: { code: SERVER_ERROR, message: `${target.displayName}: ${error.message}` } };
    }
    console.error(`MCP gateway: call to "${target.alias}" failed`, error instanceof Error ? error.name : "unknown");
    return { error: { code: SERVER_ERROR, message: `${target.displayName} could not be reached.` } };
  }
}

/** Answers one JSON-RPC request. Returns null for a notification, which has no answer. */
export async function handleRpc(userId: string, rpc: RpcRequest): Promise<RpcOutcome | null> {
  if (rpc.id === undefined) return null;

  switch (rpc.method) {
    case "initialize": {
      const asked = (rpc.params as { protocolVersion?: unknown } | undefined)?.protocolVersion;
      const protocolVersion = (SUPPORTED_PROTOCOLS as readonly string[]).includes(asked as string)
        ? (asked as string)
        : SUPPORTED_PROTOCOLS[0];
      return {
        result: {
          protocolVersion,
          capabilities: { tools: { listChanged: false } },
          serverInfo: GATEWAY_INFO,
          instructions:
            "The tools of the MCP servers this person connected on the platform. Each is named <server>__<tool>.",
        },
      };
    }
    case "ping":
      return { result: {} };
    case "tools/list":
      return listAll(userId);
    case "tools/call":
      return callOne(userId, rpc.params);
    default:
      return { error: { code: METHOD_NOT_FOUND, message: `Method not found: ${rpc.method}` } };
  }
}
