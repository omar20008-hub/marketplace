import { afterAll, beforeAll, describe, expect, it } from "vitest";
import https from "node:https";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import { transport, type TransportRequest } from "@/lib/mcp/transport";

/**
 * The transport is the one place a connection is opened to an address a person typed,
 * so it is tested against a real TLS server rather than a stub. Two promises matter most:
 * it connects only to a public address, checked at the moment of connecting, and it does
 * not follow, buffer or wait for more than it should.
 */

let haveOpenssl = true;
try {
  execFileSync("openssl", ["version"], { stdio: "ignore" });
} catch {
  haveOpenssl = false;
}

const pinned = transport.lookup;
const tlsReject = process.env.NODE_TLS_REJECT_UNAUTHORIZED;

const request = (url: string, extra: Partial<TransportRequest> = {}): TransportRequest => ({
  url: new URL(url),
  method: "POST",
  headers: { "content-type": "application/json" },
  body: "{}",
  timeoutMs: 3_000,
  maxBytes: 64 * 1024,
  ...extra,
});

describe("the connection check", () => {
  afterAll(() => {
    transport.lookup = pinned;
  });

  it("refuses, as the socket connects, a name that resolves to a private address", async () => {
    transport.lookup = pinned;
    // "localhost" resolves to a loopback address; the lookup that feeds the connection says no.
    await expect(transport.send(request("https://localhost:9/mcp"))).rejects.toMatchObject({ code: "unsafe" });
  });

  it("refuses a private address typed as a number, which is never looked up", async () => {
    transport.lookup = pinned;
    await expect(transport.send(request("https://127.0.0.1:9/mcp"))).rejects.toMatchObject({ code: "unsafe" });
    await expect(transport.send(request("https://[::1]:9/mcp"))).rejects.toMatchObject({ code: "unsafe" });
    await expect(transport.send(request("https://169.254.169.254/latest"))).rejects.toMatchObject({ code: "unsafe" });
  });
});

describe.skipIf(!haveOpenssl)("against a real TLS server", () => {
  let dir = "";
  let server: https.Server;
  let base = "";
  const hits: string[] = [];
  const events = { sseClosed: false };

  beforeAll(async () => {
    dir = mkdtempSync(path.join(tmpdir(), "mcp-tls-"));
    execFileSync(
      "openssl",
      ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", "k.pem", "-out", "c.pem", "-subj", "/CN=localhost", "-days", "1"],
      { cwd: dir, stdio: "ignore" },
    );
    process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0"; // the test certificate is self-signed
    // A loopback server is not reachable through the real lookup, by design; this one allows it.
    transport.lookup = ((_host: string, options: { all?: boolean }, callback: (...args: unknown[]) => void) =>
      options.all ? callback(null, [{ address: "127.0.0.1", family: 4 }]) : callback(null, "127.0.0.1", 4)) as typeof pinned;

    server = https.createServer(
      { key: readFileSync(path.join(dir, "k.pem")), cert: readFileSync(path.join(dir, "c.pem")) },
      (req, res) => {
        hits.push(`${req.method} ${req.url}`);
        req.resume();
        switch (req.url) {
          case "/json":
            res.writeHead(200, { "content-type": "application/json", "mcp-session-id": "s-1" });
            return void res.end('{"ok":true}');
          case "/redirect":
            res.writeHead(307, { location: "/json" });
            return void res.end();
          case "/big":
            res.writeHead(200, { "content-type": "text/plain", "content-length": String(200_000) });
            return void res.end("x".repeat(200_000));
          case "/chunked":
            res.writeHead(200, { "content-type": "text/plain" });
            for (let i = 0; i < 40; i++) res.write("y".repeat(10_000));
            return void res.end();
          case "/sse":
            // Answers, then keeps the stream open, as a streaming server may.
            res.writeHead(200, { "content-type": "text/event-stream" });
            res.write('event: message\ndata: {"jsonrpc":"2.0","id":1,"result":{"done":true}}\n\n');
            res.on("close", () => {
              events.sseClosed = true;
            });
            return;
          case "/hang":
            return; // never answers
          default:
            res.writeHead(404).end();
        }
      },
    );
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    base = `https://localhost:${(server.address() as AddressInfo).port}`;
  });

  afterAll(() => {
    server?.closeAllConnections();
    server?.close();
    transport.lookup = pinned;
    if (tlsReject === undefined) delete process.env.NODE_TLS_REJECT_UNAUTHORIZED;
    else process.env.NODE_TLS_REJECT_UNAUTHORIZED = tlsReject;
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  it("returns the status, the headers and the body", async () => {
    const response = await transport.send(request(`${base}/json`));
    expect(response.status).toBe(200);
    expect(response.headers["mcp-session-id"]).toBe("s-1");
    expect(response.text).toBe('{"ok":true}');
  });

  it("does not follow a redirect: it returns the 307 as it is", async () => {
    hits.length = 0;
    const response = await transport.send(request(`${base}/redirect`));
    expect(response.status).toBe(307);
    expect(hits).toEqual(["POST /redirect"]);
  });

  it("refuses an answer over the limit, whether declared up front or streamed", async () => {
    await expect(transport.send(request(`${base}/big`, { maxBytes: 100_000 }))).rejects.toMatchObject({
      code: "too_large",
    });
    await expect(transport.send(request(`${base}/chunked`, { maxBytes: 100_000 }))).rejects.toMatchObject({
      code: "too_large",
    });
  });

  it("stops reading an event stream once the caller has its answer, and drops the connection", async () => {
    events.sseClosed = false;
    const started = Date.now();
    const response = await transport.send(
      request(`${base}/sse`, { timeoutMs: 5_000, until: (text) => text.includes('"id":1') }),
    );
    expect(response.text).toContain('"result":{"done":true}');
    expect(Date.now() - started).toBeLessThan(2_000); // not held until the timeout
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(events.sseClosed).toBe(true);
  });

  it("gives up on a server that never answers, within the time it was given", async () => {
    const started = Date.now();
    await expect(transport.send(request(`${base}/hang`, { timeoutMs: 400 }))).rejects.toMatchObject({
      code: "timeout",
    });
    expect(Date.now() - started).toBeLessThan(2_000);
  });

  it("reports a server that is not there as unreachable", async () => {
    await expect(transport.send(request("https://localhost:1/mcp"))).rejects.toMatchObject({ code: "unreachable" });
  });
});
