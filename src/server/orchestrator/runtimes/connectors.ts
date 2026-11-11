import "server-only";
import type { ConnectorHandlers } from "../engine";
import { callUserTool, connectedServerNames, listUserTools, type UserTool } from "../../mcp-gateway";
import type { McpCallResult } from "@/lib/mcp/client";

/**
 * The Orchestrator's way into the MCP servers a person connected. It uses the same
 * code the platform's MCP endpoint does, in this process, so a person's servers are
 * reached the same way, with their own tokens, whoever is asking.
 *
 * What the model sees is bounded on purpose: a handful of tools at a time, and a
 * result cut to a size it can use. A server's own text is data and is passed on as
 * data; nothing here interprets it.
 */

const MAX_FOUND = 8;
const MAX_LISTED = 15;
const MAX_RESULT_CHARS = 6000;
const MAX_DESCRIPTION_CHARS = 300;
const MAX_FIELDS = 15;
const TRUNCATED = "\n[تم اقتطاع باقي النتيجة]";

const TOKEN = /[\p{L}\p{N}]+/gu;

function tokens(text: string): string[] {
  return (text.toLowerCase().match(TOKEN) ?? []).filter((token) => token.length >= 2);
}

/** How well a tool matches the words asked for: the number of them found in its name, server and description. */
function score(tool: UserTool, words: string[]): number {
  const haystack = `${tool.server} ${tool.name} ${tool.description}`.toLowerCase();
  return words.filter((word) => haystack.includes(word)).length;
}

type SchemaProperty = { type?: unknown; description?: unknown; enum?: unknown };

/** The fields a tool takes, as short lines a model can follow: name, type, whether required, and any fixed choices. */
export function summarizeFields(inputSchema: unknown): string[] {
  const schema = (inputSchema ?? {}) as { properties?: Record<string, SchemaProperty>; required?: unknown };
  const required = new Set(Array.isArray(schema.required) ? (schema.required as string[]) : []);
  return Object.entries(schema.properties ?? {})
    .slice(0, MAX_FIELDS)
    .map(([name, property]) => {
      const type = Array.isArray(property.type) ? property.type.join("|") : String(property.type ?? "any");
      const choices = Array.isArray(property.enum) ? ` one of ${JSON.stringify(property.enum).slice(0, 80)}` : "";
      const note = typeof property.description === "string" ? ` - ${property.description.slice(0, 80)}` : "";
      return `${name} (${type}${required.has(name) ? ", required" : ""})${choices}${note}`;
    });
}

function describe(tool: UserTool) {
  return {
    name: tool.name,
    server: tool.server,
    description: tool.description.slice(0, MAX_DESCRIPTION_CHARS),
    writes: !tool.readOnly,
    fields: summarizeFields(tool.inputSchema),
  };
}

/** What a tool answered, as text for the model, cut to a usable size. Images and files are named, not carried. */
export function formatToolResult(result: McpCallResult): string {
  const parts: string[] = [];
  for (const item of result.content ?? []) {
    const entry = item as { type?: string; text?: unknown; uri?: unknown };
    if (entry.type === "text" && typeof entry.text === "string") parts.push(entry.text);
    else if (entry.type === "resource" || entry.type === "resource_link") parts.push(`[resource${entry.uri ? ` ${String(entry.uri)}` : ""}]`);
    else parts.push(`[${entry.type ?? "content"}]`);
  }
  if (parts.length === 0 && result.structuredContent !== undefined) parts.push(JSON.stringify(result.structuredContent));

  const text = parts.join("\n");
  const cut = text.length > MAX_RESULT_CHARS ? `${text.slice(0, MAX_RESULT_CHARS)}${TRUNCATED}` : text;
  return JSON.stringify({
    result: result.isError ? "error" : "ok",
    ...(result.isError ? { errorType: "tool_reported_error" } : {}),
    content: cut,
  });
}

/** The handlers for one person, or undefined when they have connected no MCP server. */
export async function createConnectorHandlers(userId: string): Promise<ConnectorHandlers | undefined> {
  const servers = await connectedServerNames(userId);
  if (servers.length === 0) return undefined;

  return {
    servers,

    async find(query) {
      const tools = await listUserTools(userId);
      if (tools.length === 0) {
        return JSON.stringify({ result: "ok", tools: [], note: "لا توجد أدوات متاحة الآن في الخدمات المتصلة." });
      }
      const words = tokens(query);
      const ranked = words.length
        ? tools
            .map((tool) => ({ tool, points: score(tool, words) }))
            .filter((entry) => entry.points > 0)
            .sort((a, b) => b.points - a.points)
            .slice(0, MAX_FOUND)
            .map((entry) => entry.tool)
        : [];
      if (ranked.length > 0) return JSON.stringify({ result: "ok", tools: ranked.map(describe) });

      // Nothing matched the words (or none were given): show what exists, briefly, so the model can choose.
      return JSON.stringify({
        result: "ok",
        note: words.length ? "لا أداة تطابق هذه الكلمات. هذه الأدوات المتاحة:" : "الأدوات المتاحة:",
        tools: tools.slice(0, MAX_LISTED).map(describe),
        ...(tools.length > MAX_LISTED ? { more: tools.length - MAX_LISTED } : {}),
      });
    },

    async writes(name) {
      const tool = (await listUserTools(userId)).find((candidate) => candidate.name === name);
      return tool ? !tool.readOnly : undefined;
    },

    async call(name, args) {
      const outcome = await callUserTool(userId, name, args);
      if ("error" in outcome) {
        // The gateway's own messages: a server's name and what went wrong, with nothing secret in them.
        return JSON.stringify({ result: "error", errorType: "tool_failed", message: outcome.error.message });
      }
      return formatToolResult(outcome.result as McpCallResult);
    },
  };
}
