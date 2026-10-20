import { describe, expect, it, vi } from "vitest";
import { createWebSearch } from "@/server/orchestrator/runtimes/web";

/** Web search with a stubbed relay: what is sent out, what comes back, and what a failure looks like. */

function textResponse(body: string, status = 200) {
  return new Response(body, { status });
}

describe("createWebSearch", () => {
  it("sends only the encoded query through the relay", async () => {
    const fetchImpl = vi.fn(async () => textResponse("نتيجة"));

    await createWebSearch({ fetchImpl: fetchImpl as unknown as typeof fetch })("next.js 16 release");

    const [url] = fetchImpl.mock.calls[0] as unknown as [string];
    expect(url).toBe(
      "https://r.jina.ai/https://html.duckduckgo.com/html/?q=next.js%2016%20release",
    );
  });

  it("returns the text, cut to 6000 characters", async () => {
    const fetchImpl = vi.fn(async () => textResponse("a".repeat(9000)));

    const answer = await createWebSearch({ fetchImpl: fetchImpl as unknown as typeof fetch })("q");

    expect(answer).toHaveLength(6000);
  });

  it("reports a failed relay as a search error rather than an empty result", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const fetchImpl = vi.fn(async () => textResponse("busy", 503));

    const answer = await createWebSearch({ fetchImpl: fetchImpl as unknown as typeof fetch })("q");

    expect(JSON.parse(answer)).toEqual({ result: "error", errorType: "search_unavailable" });
  });

  it("reports a network failure as a search error", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const fetchImpl = vi.fn(async () => {
      throw new TypeError("fetch failed");
    });

    const answer = await createWebSearch({ fetchImpl: fetchImpl as unknown as typeof fetch })("q");

    expect(JSON.parse(answer)).toEqual({ result: "error", errorType: "search_unavailable" });
  });
});
