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
/** A server that failed is not asked again for a little while, so a dead one costs one wait, not one per call. */
const FAILURE_CACHE_MS = 30_000;
const MAX_CACHED = 500;
const listCache = new Map<string, { at: number; tools: McpTool[] }>();
const failureCache = new Map<string, { at: number; error: McpError }>();

/** Keeps the caches from growing without bound on a long-running process. */
function trim<T>(cache: Map<string, T>) {
  if (cache.size <= MAX_CACHED) return;
  const oldest = cache.keys().next().value;
  if (oldest !== undefined) cache.delete(oldest);
}

/** Replaceable in tests, so no test reaches a real server. */
export const gatewayRuntime = { listTools, callTool };

type Connected = { id: string; displayName: string; alias: string; server: McpServer };

async function connectedServers(userId: string): Promise<Connected[]> {
  // Aliases are worked out over every server the person still has, in a fixed order, so
  // one lapsing or being kept private does not rename the others.
  const all = await prisma.connector.findMany({
    where: { userId, credentialType: MCP_CREDENTIAL, status: { not: "REVOKED" } },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
  });
  const aliases = assignAliases(all);

  const connected: Connected[] = [];
  for (const row of all) {
    if (row.status !== "ACTIVE" || !row.reusable || !row.secretJson) continue;
    let secret: Record<string, string>;
    try {
      secret = openCredential(row.secretJson);
    } catch {
      // A row that cannot be read (a rotated secrets key, a damaged value) must not
      // take the person's other servers down with it.
      console.warn(`MCP gateway: could not read the stored secret of "${aliases.get(row.id)}"`);
      continue;
    }
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
  const failed = failureCache.get(connected.id);
  if (failed && Date.now() - failed.at < FAILURE_CACHE_MS) throw failed.error;

  try {
    const tools = await gatewayRuntime.listTools(connected.server);
    listCache.set(connected.id, { at: Date.now(), tools });
    trim(listCache);
    return tools;
  } catch (error) {
    if (error instanceof McpError) {
      failureCache.set(connected.id, { at: Date.now(), error });
      trim(failureCache);
    }
    throw error;
  }
}

/** Forgets what is cached about a server, for when it is connected again or removed. */
export function forgetTools(connectorId: string) {
  listCache.delete(connectorId);
  failureCache.delete(connectorId);
}

/** A server whose token was refused (401) is marked for reconnecting, as any other connection is. */
async function markExpired(userId: string, connectorId: string) {
  await prisma.connector.updateMany({
    where: { id: connectorId, userId, status: "ACTIVE" },
    data: { status: "EXPIRED" },
  });
  forgetTools(connectorId);
  await refreshInstallationStates(userId);
}

type Collected = { name: string; displayName: string; tool: McpTool };

/** Every tool of the person's servers, each under the name the gateway gives it. One server being down leaves the rest. */
async function collectTools(userId: string): Promise<Collected[]> {
  const servers = await connectedServers(userId);
  const settled = await Promise.allSettled(servers.map(toolsOf));

  const collected: Collected[] = [];
  settled.forEach((outcome, index) => {
    const { alias, displayName } = servers[index];
    if (outcome.status === "rejected") {
      const code = outcome.reason instanceof McpError ? outcome.reason.code : "error";
      console.warn(`MCP gateway: could not list tools for "${alias}": ${code}`);
      return;
    }
    for (const tool of outcome.value) {
      const name = namespacedName(alias, tool.name);
      if (name) collected.push({ name, displayName, tool });
    }
  });
  return collected;
}

async function listAll(userId: string): Promise<RpcOutcome> {
  const tools = (await collectTools(userId)).map(({ name, displayName, tool }) => ({
    name,
    ...(tool.title ? { title: tool.title } : {}),
    description: `[${displayName}] ${tool.description ?? tool.name}`,
    inputSchema: tool.inputSchema ?? { type: "object", properties: {} },
    ...(tool.annotations ? { annotations: tool.annotations } : {}),
  }));
  return { result: { tools } };
}

/** What the Orchestrator is told about a tool. */
export type UserTool = {
  /** <server>__<tool>, as the gateway names it. */
  name: string;
  server: string;
  description: string;
  inputSchema: unknown;
  /**
   * True only when the server itself says the tool changes nothing (readOnlyHint). A tool
   * that says nothing is treated as able to change things, which is the protocol's own default.
   */
  readOnly: boolean;
};

/** The same tools the endpoint lists, for code that runs in this process. */
export async function listUserTools(userId: string): Promise<UserTool[]> {
  return (await collectTools(userId)).map(({ name, displayName, tool }) => ({
    name,
    server: displayName,
    description: tool.description ?? tool.title ?? tool.name,
    inputSchema: tool.inputSchema ?? { type: "object", properties: {} },
    readOnly: (tool.annotations as { readOnlyHint?: unknown } | undefined)?.readOnlyHint === true,
  }));
}

/** The names of the servers offered to this person's agents, without asking any of them for its tools. */
export async function connectedServerNames(userId: string): Promise<string[]> {
  return (await connectedServers(userId)).map((server) => server.displayName);
}

/** Calls one of the person's tools by its gateway name. Never throws: a failure is an `error` outcome. */
export async function callUserTool(userId: string, name: unknown, args: unknown): Promise<RpcOutcome> {
  return callOne(userId, { name, arguments: args });
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
