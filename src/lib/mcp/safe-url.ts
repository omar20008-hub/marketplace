import { lookup } from "node:dns/promises";
import { isIP } from "node:net";

/**
 * The platform connects to MCP servers at addresses people type in, so the
 * address is the attack surface: a person could point it at the cloud metadata
 * service, the database, or anything else inside Railway's private network.
 *
 * An address is accepted only if it is https, on the default port, free of
 * credentials and query strings (a token in a URL ends up in logs), and every
 * address its name resolves to is a public one. Redirects are refused by the
 * caller, so a public name cannot bounce the request somewhere private.
 *
 * The name is resolved here and again when fetch connects, so a name that
 * answers differently the second time (DNS rebinding) is a gap this check
 * narrows but does not close. Servers that matter should be on a name the
 * person controls; see docs/mcp-gateway.md.
 */

export class UnsafeUrlError extends Error {
  constructor(readonly reason: "scheme" | "credentials" | "query" | "port" | "host" | "private" | "unresolved") {
    super(`unsafe MCP address: ${reason}`);
    this.name = "UnsafeUrlError";
  }
}

function ipv4Parts(address: string): number[] | null {
  const parts = address.split(".").map(Number);
  return parts.length === 4 && parts.every((p) => Number.isInteger(p) && p >= 0 && p <= 255) ? parts : null;
}

function privateIpv4(parts: number[]): boolean {
  const [a, b, c] = parts;
  return (
    a === 0 || // "this network", including 0.0.0.0
    a === 10 ||
    a === 127 ||
    (a === 100 && b >= 64 && b <= 127) || // carrier-grade NAT
    (a === 169 && b === 254) || // link-local, including the cloud metadata address
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 0 && c === 0) ||
    (a === 192 && b === 0 && c === 2) ||
    (a === 192 && b === 168) ||
    (a === 198 && (b === 18 || b === 19)) ||
    (a === 198 && b === 51 && c === 100) ||
    (a === 203 && b === 0 && c === 113) ||
    a >= 224 // multicast, reserved and broadcast
  );
}

/** Expands an IPv6 address to its eight 16-bit groups, or null if it is not one. */
function ipv6Groups(address: string): number[] | null {
  let text = address.toLowerCase();
  const zone = text.indexOf("%");
  if (zone !== -1) text = text.slice(0, zone);

  // An embedded IPv4 tail ("::ffff:10.0.0.1") becomes two groups.
  const tail = text.lastIndexOf(":");
  if (text.includes(".")) {
    const v4 = ipv4Parts(text.slice(tail + 1));
    if (!v4) return null;
    text = `${text.slice(0, tail + 1)}${((v4[0] << 8) | v4[1]).toString(16)}:${((v4[2] << 8) | v4[3]).toString(16)}`;
  }

  const halves = text.split("::");
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(":") : [];
  const rest = halves.length === 2 && halves[1] ? halves[1].split(":") : [];
  const missing = 8 - head.length - rest.length;
  if (halves.length === 1 ? head.length !== 8 : missing < 0) return null;

  const groups = [...head, ...Array(halves.length === 2 ? missing : 0).fill("0"), ...rest].map((g) =>
    /^[0-9a-f]{1,4}$/.test(g) ? parseInt(g, 16) : NaN,
  );
  return groups.length === 8 && groups.every((g) => !Number.isNaN(g)) ? groups : null;
}

/** True for any address that is not a plain public one, IPv4 or IPv6. Unparseable input counts as private. */
export function isPrivateAddress(address: string): boolean {
  if (isIP(address) === 4) {
    const parts = ipv4Parts(address);
    return !parts || privateIpv4(parts);
  }
  const groups = ipv6Groups(address);
  if (!groups) return true;
  const [g0, g1, g2, g3, g4, g5, g6, g7] = groups;

  const embedded = [g6 >> 8, g6 & 255, g7 >> 8, g7 & 255];
  // ::ffff:a.b.c.d (IPv4-mapped), ::a.b.c.d (compatible) and 64:ff9b::/96 (NAT64) carry an IPv4 address.
  if (g0 === 0 && g1 === 0 && g2 === 0 && g3 === 0 && g4 === 0 && (g5 === 0xffff || g5 === 0)) {
    // :: and ::1 fall out here as 0.0.0.0 and 0.0.0.1, both private.
    return privateIpv4(embedded);
  }
  if (g0 === 0x64 && g1 === 0xff9b) return privateIpv4(embedded);
  if (g0 === 0x2002) return privateIpv4([g1 >> 8, g1 & 255, g2 >> 8, g2 & 255]); // 6to4

  return (
    (g0 & 0xfe00) === 0xfc00 || // unique local, fc00::/7
    (g0 & 0xffc0) === 0xfe80 || // link-local, fe80::/10
    (g0 & 0xff00) === 0xff00 || // multicast
    (g0 === 0x2001 && g1 === 0x0db8) || // documentation
    (g0 & 0xe000) !== 0x2000 // anything outside global unicast, 2000::/3
  );
}

type Resolver = (hostname: string) => Promise<string[]>;

const resolveAll: Resolver = async (hostname) =>
  (await lookup(hostname, { all: true, verbatim: true })).map((entry) => entry.address);

/** The URL, parsed and checked, or an UnsafeUrlError saying why not. `resolve` is replaceable in tests. */
export async function assertPublicHttpsUrl(raw: string, resolve: Resolver = resolveAll): Promise<URL> {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    throw new UnsafeUrlError("scheme");
  }
  if (url.protocol !== "https:") throw new UnsafeUrlError("scheme");
  if (url.username || url.password) throw new UnsafeUrlError("credentials");
  if (url.search || url.hash) throw new UnsafeUrlError("query");
  if (url.port && url.port !== "443") throw new UnsafeUrlError("port");

  // "internal." is the same name as "internal", so the trailing dot must not hide it.
  const host = url.hostname.replace(/^\[|\]$/g, "").replace(/\.$/, "").toLowerCase();
  if (
    !host ||
    host === "localhost" ||
    host.endsWith(".localhost") ||
    host.endsWith(".local") ||
    host.endsWith(".internal") ||
    host.endsWith(".railway.internal")
  ) {
    throw new UnsafeUrlError("host");
  }

  if (isIP(host)) {
    if (isPrivateAddress(host)) throw new UnsafeUrlError("private");
    return url;
  }

  let addresses: string[];
  try {
    addresses = await resolve(host);
  } catch {
    throw new UnsafeUrlError("unresolved");
  }
  if (addresses.length === 0) throw new UnsafeUrlError("unresolved");
  if (addresses.some(isPrivateAddress)) throw new UnsafeUrlError("private");
  return url;
}
