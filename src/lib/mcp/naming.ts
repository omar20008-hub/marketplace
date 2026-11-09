/**
 * How tools from several MCP servers share one name space. The gateway shows an
 * agent every tool as <server>__<tool>, so two servers that both offer "search"
 * do not collide, and a call can be routed back to the server it came from.
 * Pure functions, no database, so each rule is testable on its own.
 */

/** The Connector.credentialType every connected MCP server is stored under. */
export const MCP_CREDENTIAL = "mcpServer";
/** At most this many servers per person: each one is a list call on every tools/list. */
export const MAX_MCP_SERVERS = 10;

const SEPARATOR = "__";
const MAX_ALIAS_CHARS = 20;
/** Many MCP clients refuse a tool name longer than this. */
const MAX_TOOL_NAME_CHARS = 64;
const TOOL_NAME = /^[A-Za-z0-9_.-]+$/;

/** A short, lowercase, underscore-joined name for a server, never containing "__". */
export function aliasFor(displayName: string): string {
  const alias = displayName
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, MAX_ALIAS_CHARS)
    .replace(/_+$/g, "");
  return alias || "server";
}

/**
 * One alias per server, unique among them. The first to ask keeps the plain alias
 * and later ones get _2, _3, so the order the caller passes (oldest first) decides
 * who keeps which. Pass every server the person still has, whatever its state, or an
 * alias would change whenever an older server lapsed.
 */
export function assignAliases<T extends { id: string; displayName: string }>(servers: T[]): Map<string, string> {
  const taken = new Set<string>();
  const aliases = new Map<string, string>();
  for (const server of servers) {
    const base = aliasFor(server.displayName);
    let alias = base;
    for (let n = 2; taken.has(alias); n++) {
      const suffix = `_${n}`;
      // Cut the base first and drop any underscore it ends on, so "abc_" + "_2" cannot
      // become "abc__2", whose "__" would be read as the tool separator.
      const room = base.slice(0, MAX_ALIAS_CHARS - suffix.length).replace(/_+$/, "");
      alias = `${room || "server"}${suffix}`;
    }
    taken.add(alias);
    aliases.set(server.id, alias);
  }
  return aliases;
}

/** The name an agent sees, or null when it cannot be one (too long, or characters clients reject). */
export function namespacedName(alias: string, tool: string): string | null {
  if (!TOOL_NAME.test(tool)) return null;
  const name = `${alias}${SEPARATOR}${tool}`;
  return name.length <= MAX_TOOL_NAME_CHARS ? name : null;
}

/** Splits a name the gateway issued back into the server alias and the tool's own name. */
export function splitNamespacedName(name: string): { alias: string; tool: string } | null {
  const at = name.indexOf(SEPARATOR);
  if (at <= 0 || at + SEPARATOR.length >= name.length) return null;
  return { alias: name.slice(0, at), tool: name.slice(at + SEPARATOR.length) };
}
