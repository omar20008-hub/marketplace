import { describe, expect, it, vi } from "vitest";
import { createGeminiModel } from "@/server/orchestrator/gemini";
import { ModelError, ModelUnavailableError, type ModelRequest } from "@/server/orchestrator/model";

/** The Gemini adapter against a stubbed fetch: wire format in, neutral reply out. */

const REQUEST: ModelRequest = {
  system: "أنت مساعد",
  tools: [{ name: "web_search", description: "بحث", parameters: { type: "object" } }],
  messages: [
    { role: "user", content: "سؤال" },
    {
      role: "assistant",
      content: "",
      toolCalls: [{ id: "c1", name: "web_search", args: { query: "q" } }],
    },
    { role: "tool", toolCallId: "c1", name: "web_search", content: "نتيجة" },
  ],
};

function respond(status: number, body: unknown) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function adapter(fetchImpl: typeof fetch) {
  return createGeminiModel({
    apiKey: "test-key",
    model: "gemini-3.1-flash-lite",
    fetchImpl,
  });
}

describe("createGeminiModel — request", () => {
  it("posts to the model's endpoint with the key in a header, not in the URL", async () => {
    const fetchImpl = vi.fn(async () => respond(200, { candidates: [{ content: { parts: [{ text: "ok" }] } }] }));

    await adapter(fetchImpl as unknown as typeof fetch).generate(REQUEST);

    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(
      "https://generativelanguage.googleapis.com/v1beta/models/gemini-3.1-flash-lite:generateContent",
    );
    expect(url).not.toContain("test-key");
    expect((init.headers as Record<string, string>)["x-goog-api-key"]).toBe("test-key");
  });

  it("maps the system prompt, tools and the whole history into Gemini's shape", async () => {
    const fetchImpl = vi.fn(async () => respond(200, { candidates: [{ content: { parts: [{ text: "ok" }] } }] }));

    await adapter(fetchImpl as unknown as typeof fetch).generate(REQUEST);

    const body = JSON.parse(((fetchImpl.mock.calls[0] as unknown as [string, RequestInit])[1]).body as string);
    expect(body.systemInstruction.parts[0].text).toBe("أنت مساعد");
    expect(body.tools[0].functionDeclarations[0].name).toBe("web_search");
    expect(body.contents).toEqual([
      { role: "user", parts: [{ text: "سؤال" }] },
      { role: "model", parts: [{ functionCall: { name: "web_search", args: { query: "q" } } }] },
      { role: "user", parts: [{ functionResponse: { name: "web_search", response: { result: "نتيجة" } } }] },
    ]);
  });

  it("groups several tool results into one user turn", async () => {
    const fetchImpl = vi.fn(async () => respond(200, { candidates: [{ content: { parts: [{ text: "ok" }] } }] }));
    const request: ModelRequest = {
      system: "s",
      tools: [],
      messages: [
        {
          role: "assistant",
          content: "",
          toolCalls: [
            { id: "a", name: "web_search", args: {} },
            { id: "b", name: "web_search", args: {} },
          ],
        },
        { role: "tool", toolCallId: "a", name: "web_search", content: "1" },
        { role: "tool", toolCallId: "b", name: "web_search", content: "2" },
      ],
    };

    await adapter(fetchImpl as unknown as typeof fetch).generate(request);

    const body = JSON.parse(((fetchImpl.mock.calls[0] as unknown as [string, RequestInit])[1]).body as string);
    expect(body.contents).toHaveLength(2);
    expect(body.contents[1].parts).toHaveLength(2);
    expect(body.tools).toBeUndefined();
  });
});

describe("createGeminiModel — reply", () => {
  it("returns the text of a plain answer", async () => {
    const fetchImpl = vi.fn(async () =>
      respond(200, { candidates: [{ content: { parts: [{ text: "  مرحباً  " }] } }] }),
    );

    expect(await adapter(fetchImpl as unknown as typeof fetch).generate(REQUEST)).toEqual({
      text: "مرحباً",
      toolCalls: [],
    });
  });

  it("returns the function calls it was asked for, with their arguments", async () => {
    const fetchImpl = vi.fn(async () =>
      respond(200, {
        candidates: [
          {
            content: {
              parts: [
                { functionCall: { name: "run_marketplace_tool", args: { installationId: "inst_1", args: "{}" } } },
              ],
            },
          },
        ],
      }),
    );

    const reply = await adapter(fetchImpl as unknown as typeof fetch).generate(REQUEST);

    expect(reply.toolCalls).toEqual([
      { id: "call_0", name: "run_marketplace_tool", args: { installationId: "inst_1", args: "{}" } },
    ]);
  });

  it("treats a blocked request as a refusal, not as an empty answer", async () => {
    const fetchImpl = vi.fn(async () => respond(200, { promptFeedback: { blockReason: "SAFETY" } }));

    await expect(adapter(fetchImpl as unknown as typeof fetch).generate(REQUEST)).rejects.toBeInstanceOf(ModelError);
  });

  it("treats an empty candidate as a refusal", async () => {
    const fetchImpl = vi.fn(async () =>
      respond(200, { candidates: [{ content: { parts: [] }, finishReason: "MAX_TOKENS" }] }),
    );

    await expect(adapter(fetchImpl as unknown as typeof fetch).generate(REQUEST)).rejects.toBeInstanceOf(ModelError);
  });
});

describe("createGeminiModel — failures", () => {
  it.each([429, 500, 503])("marks a %i as unavailable, so the engine can fall back", async (status) => {
    const fetchImpl = vi.fn(async () => respond(status, { error: "busy" }));

    await expect(adapter(fetchImpl as unknown as typeof fetch).generate(REQUEST)).rejects.toBeInstanceOf(
      ModelUnavailableError,
    );
  });

  it("marks a network failure as unavailable", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new TypeError("fetch failed");
    });

    await expect(adapter(fetchImpl as unknown as typeof fetch).generate(REQUEST)).rejects.toBeInstanceOf(
      ModelUnavailableError,
    );
  });

  it.each([400, 401, 403])("marks a %i as a refusal that falling back will not fix", async (status) => {
    const fetchImpl = vi.fn(async () => respond(status, { error: "no" }));

    await expect(adapter(fetchImpl as unknown as typeof fetch).generate(REQUEST)).rejects.toBeInstanceOf(ModelError);
  });

  it("does not put the key into the error message", async () => {
    const fetchImpl = vi.fn(async () => respond(401, { error: "bad key" }));

    const error = await adapter(fetchImpl as unknown as typeof fetch)
      .generate(REQUEST)
      .catch((e: Error) => e);

    expect((error as Error).message).not.toContain("test-key");
  });
});

describe("createGeminiModel — thought signatures", () => {
  it("keeps the signature from a function call and sends it back on the next request", async () => {
    const fetchImpl = vi.fn(async () =>
      respond(200, {
        candidates: [
          {
            content: {
              parts: [{ functionCall: { name: "web_search", args: { query: "q" } }, thoughtSignature: "sig-1" }],
            },
          },
        ],
      }),
    );
    const reply = await adapter(fetchImpl as unknown as typeof fetch).generate(REQUEST);
    expect(reply.toolCalls[0].providerState).toEqual({ thoughtSignature: "sig-1" });

    const next: ModelRequest = {
      ...REQUEST,
      messages: [
        { role: "user", content: "سؤال" },
        { role: "assistant", content: "", toolCalls: reply.toolCalls },
        { role: "tool", toolCallId: reply.toolCalls[0].id, name: "web_search", content: "نتيجة" },
      ],
    };
    fetchImpl.mockImplementationOnce(async () => respond(200, { candidates: [{ content: { parts: [{ text: "ok" }] } }] }));
    await adapter(fetchImpl as unknown as typeof fetch).generate(next);

    const body = JSON.parse(((fetchImpl.mock.calls[1] as unknown as [string, RequestInit])[1]).body as string);
    expect(body.contents[1].parts[0]).toEqual({
      functionCall: { name: "web_search", args: { query: "q" } },
      thoughtSignature: "sig-1",
    });
  });

  it("gives the first of several calls the turn's signature when it sits on a text part", async () => {
    const fetchImpl = vi.fn(async () =>
      respond(200, {
        candidates: [
          {
            content: {
              parts: [
                { text: "", thoughtSignature: "turn-sig" },
                { functionCall: { name: "web_search", args: {} } },
                { functionCall: { name: "web_search", args: { query: "b" } } },
              ],
            },
          },
        ],
      }),
    );
    const reply = await adapter(fetchImpl as unknown as typeof fetch).generate(REQUEST);
    expect(reply.toolCalls[0].providerState).toEqual({ thoughtSignature: "turn-sig" });
    expect(reply.toolCalls[1].providerState).toBeUndefined();
  });
});
