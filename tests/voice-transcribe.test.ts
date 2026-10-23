import { describe, expect, it, vi } from "vitest";
import { baseAudioType, directionOf, transcribe } from "@/server/voice/transcribe";

/** Speech to text against a stubbed Gemini: request shape in, { text, language } out. */

const AUDIO = new Uint8Array([1, 2, 3, 4]);

function respond(status: number, body: unknown) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function reply(json: unknown) {
  return respond(200, { candidates: [{ content: { parts: [{ text: JSON.stringify(json) }] } }] });
}

function run(fetchImpl: typeof fetch, models = ["m1", "m2"]) {
  return transcribe({ audio: AUDIO, mimeType: "audio/wav", apiKey: "test-key", models, fetchImpl });
}

describe("transcribe — request", () => {
  it("sends the audio inline, the key in a header, and asks for the spoken language without translating", async () => {
    const fetchImpl = vi.fn(async () => reply({ language: "ar", text: "مرحبا" }));
    await run(fetchImpl as unknown as typeof fetch);

    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://generativelanguage.googleapis.com/v1beta/models/m1:generateContent");
    expect(url).not.toContain("test-key");
    expect((init.headers as Record<string, string>)["x-goog-api-key"]).toBe("test-key");
    const body = JSON.parse(init.body as string);
    expect(body.contents[0].parts[0].inlineData).toEqual({
      mimeType: "audio/wav",
      data: Buffer.from(AUDIO).toString("base64"),
    });
    expect(body.contents[0].parts[1].text).toMatch(/Do not translate/);
    expect(body.generationConfig.responseMimeType).toBe("application/json");
  });
});

describe("transcribe — reply", () => {
  it("returns Arabic speech as Arabic text, right to left", async () => {
    const result = await run((async () => reply({ language: "ar", text: " مرحبا بك " })) as unknown as typeof fetch);
    expect(result).toEqual({ ok: true, text: "مرحبا بك", language: "ar", direction: "rtl" });
  });

  it("returns English speech as English text, left to right", async () => {
    const result = await run((async () => reply({ language: "en-US", text: "hello" })) as unknown as typeof fetch);
    expect(result).toEqual({ ok: true, text: "hello", language: "en-us", direction: "ltr" });
  });

  it("marks a language code it cannot read as undetermined, and keeps the text", async () => {
    const result = await run((async () => reply({ language: "Arabic!", text: "x" })) as unknown as typeof fetch);
    expect(result).toMatchObject({ ok: true, language: "und", direction: "ltr" });
  });

  it("says nothing was heard when the text is empty", async () => {
    const result = await run((async () => reply({ language: "und", text: "" })) as unknown as typeof fetch);
    expect(result).toEqual({ ok: false, reason: "no_speech" });
  });

  it("fails on a reply that is not the asked-for JSON", async () => {
    const fetchImpl = async () => respond(200, { candidates: [{ content: { parts: [{ text: "not json" }] } }] });
    expect(await run(fetchImpl as unknown as typeof fetch)).toEqual({ ok: false, reason: "failed" });
  });
});

describe("transcribe — availability", () => {
  it("moves to the next model when the first is busy", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(respond(503, {}))
      .mockResolvedValueOnce(reply({ language: "fr", text: "bonjour" }));
    const result = await run(fetchImpl as unknown as typeof fetch);
    expect(result).toMatchObject({ ok: true, text: "bonjour" });
    expect(String(fetchImpl.mock.calls[1][0])).toContain("/models/m2:");
  });

  it("is unavailable when every model is busy or unreachable", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(respond(429, {}))
      .mockRejectedValueOnce(new Error("network down"));
    expect(await run(fetchImpl as unknown as typeof fetch)).toEqual({ ok: false, reason: "unavailable" });
  });

  it("does not try another model after a refusal", async () => {
    const fetchImpl = vi.fn(async () => respond(400, {}));
    expect(await run(fetchImpl as unknown as typeof fetch)).toEqual({ ok: false, reason: "failed" });
    expect(fetchImpl).toHaveBeenCalledOnce();
  });

  it("is unavailable without a key, and calls nothing", async () => {
    const fetchImpl = vi.fn();
    const result = await transcribe({ audio: AUDIO, mimeType: "audio/wav", apiKey: "", models: ["m1"], fetchImpl });
    expect(result).toEqual({ ok: false, reason: "unavailable" });
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe("helpers", () => {
  it("accepts recording formats and drops their parameters", () => {
    expect(baseAudioType("audio/webm;codecs=opus")).toBe("audio/webm");
    expect(baseAudioType("AUDIO/WAV")).toBe("audio/wav");
    expect(baseAudioType("video/mp4")).toBeNull();
    expect(baseAudioType("")).toBeNull();
  });

  it("knows which languages run right to left", () => {
    expect(directionOf("ar")).toBe("rtl");
    expect(directionOf("ar-SA")).toBe("rtl");
    expect(directionOf("ur")).toBe("rtl");
    expect(directionOf("en")).toBe("ltr");
    expect(directionOf("und")).toBe("ltr");
  });
});
