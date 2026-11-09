import "server-only";
import https from "node:https";
import { lookup as dnsLookup } from "node:dns";
import { isIP } from "node:net";
import { McpError } from "./errors";
import { isPrivateAddress } from "./safe-url";

/**
 * The one place the platform opens a connection to an address a person typed.
 *
 * It is written on node:https rather than fetch for one reason: the address is
 * checked at the moment the socket connects. A fetch would resolve the name once
 * to check it and again to connect, and a name that answers "public" the first
 * time and "internal" the second (DNS rebinding) would get through. Here the
 * lookup that feeds the connection is the one that is checked, so the socket can
 * only reach an address that passed.
 *
 * Redirects are not followed (a 3xx is returned as it is and treated as a
 * failure by the caller). The body is read up to a limit, and may stop early once
 * the caller has what it needs, so a server that keeps a stream open cannot hold
 * the request until it times out.
 */

export type TransportRequest = {
  url: URL;
  method: "POST" | "DELETE";
  headers: Record<string, string>;
  body?: string;
  timeoutMs: number;
  maxBytes: number;
  /** Called with the text so far; true means the answer is complete and the rest can be dropped. */
  until?: (text: string, headers: Record<string, string>) => boolean;
};

export type TransportResponse = { status: number; headers: Record<string, string>; text: string };

type LookupCallback = (error: Error | null, address?: string | { address: string; family: number }[], family?: number) => void;

/** A DNS lookup that refuses any answer containing an address that is not a public one. */
function pinnedLookup(hostname: string, options: { all?: boolean; family?: number }, callback: LookupCallback) {
  dnsLookup(hostname, { all: true, verbatim: true, family: options.family }, (error, addresses) => {
    if (error) return callback(error);
    const found = addresses as unknown as { address: string; family: number }[];
    if (found.length === 0 || found.some((entry) => isPrivateAddress(entry.address))) {
      return callback(Object.assign(new Error("address not allowed"), { code: "EMCP_PRIVATE" }));
    }
    if (options.all) return callback(null, found);
    return callback(null, found[0].address, found[0].family);
  });
}

function send(request: TransportRequest): Promise<TransportResponse> {
  return new Promise((resolve, reject) => {
    const host = request.url.hostname.replace(/^\[|\]$/g, "");
    // An address typed as a number is never looked up, so it is checked here.
    if (isIP(host) && isPrivateAddress(host)) {
      return reject(new McpError("That address cannot be used.", "unsafe"));
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), request.timeoutMs);
    let settled = false;
    const finish = (outcome: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      outcome();
    };

    const body = request.body === undefined ? undefined : Buffer.from(request.body, "utf8");
    const outgoing = https.request(
      {
        host,
        // assertPublicHttpsUrl has already limited a person's address to 443; the URL's own port is used as given.
        port: Number(request.url.port) || 443,
        path: request.url.pathname,
        method: request.method,
        headers: { ...request.headers, ...(body ? { "content-length": String(body.length) } : {}) },
        lookup: transport.lookup as never,
        signal: controller.signal,
      },
      (response) => {
        const headers: Record<string, string> = {};
        for (const [name, value] of Object.entries(response.headers)) {
          if (value !== undefined) headers[name] = Array.isArray(value) ? value.join(", ") : value;
        }
        const status = response.statusCode ?? 0;
        const streaming = (headers["content-type"] ?? "").includes("text/event-stream");

        const declared = Number(headers["content-length"]);
        if (declared > request.maxBytes) {
          response.destroy();
          return finish(() => reject(new McpError("The server's answer is too large.", "too_large")));
        }

        const chunks: Buffer[] = [];
        let total = 0;
        response.on("data", (chunk: Buffer) => {
          total += chunk.length;
          if (total > request.maxBytes) {
            response.destroy();
            return finish(() => reject(new McpError("The server's answer is too large.", "too_large")));
          }
          chunks.push(chunk);
          if (streaming && request.until && !settled) {
            const text = Buffer.concat(chunks).toString("utf8");
            if (request.until(text, headers)) {
              response.destroy();
              finish(() => resolve({ status, headers, text }));
            }
          }
        });
        response.on("end", () =>
          finish(() => resolve({ status, headers, text: Buffer.concat(chunks).toString("utf8") })),
        );
        response.on("error", () => finish(() => reject(new McpError("The server could not be reached.", "unreachable"))));
        response.on("close", () => {
          // A stream cut off before its end is a failure, unless we ended it on purpose.
          if (!response.complete) {
            finish(() => reject(new McpError("The server closed the connection early.", "unreachable")));
          }
        });
      },
    );

    outgoing.on("error", (error: NodeJS.ErrnoException) => {
      if (controller.signal.aborted) {
        return finish(() => reject(new McpError("The server took too long to answer.", "timeout")));
      }
      if (error.code === "EMCP_PRIVATE") {
        return finish(() => reject(new McpError("That address cannot be used.", "unsafe")));
      }
      return finish(() => reject(new McpError("The server could not be reached.", "unreachable")));
    });

    if (body) outgoing.write(body);
    outgoing.end();
  });
}

/** Replaceable in tests: `send` so no test opens a connection, `lookup` so one can reach a local server. */
export const transport = { send, lookup: pinnedLookup };
