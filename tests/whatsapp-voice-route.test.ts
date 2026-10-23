import { beforeEach, describe, expect, it, vi } from "vitest";

/** POST /api/channels/whatsapp/voice: n8n posts a voice note, the words come back in their own language. */

const state = vi.hoisted(() => ({ authorised: true, linked: new Map<string, string>() }));
const transcribeMock = vi.hoisted(() => vi.fn());

vi.mock("@/lib/channel-token", () => ({ channelCallAuthorised: () => state.authorised }));
vi.mock("@/server/channel-links", () => ({
  WHATSAPP: "whatsapp",
  resolveChannelUser: async (_channel: string, id: string) => state.linked.get(id) ?? null,
}));
vi.mock("@/server/voice/transcribe", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/server/voice/transcribe")>();
  return { ...actual, transcribe: transcribeMock };
});

const { POST } = await import("@/app/api/channels/whatsapp/voice/route");

let next = 0;

function voiceNote(fields: { whatsappUserId?: string; file?: Blob | null; mimeType?: string }) {
  const form = new FormData();
  if (fields.whatsappUserId !== undefined) form.append("whatsappUserId", fields.whatsappUserId);
  if (fields.file) form.append("file", fields.file, "voice.ogg");
  if (fields.mimeType) form.append("mimeType", fields.mimeType);
  return new Request("http://localhost/api/channels/whatsapp/voice", { method: "POST", body: form });
}

const OGG = () => new Blob([new Uint8Array(32)], { type: "audio/ogg; codecs=opus" });

let number = "";

beforeEach(() => {
  transcribeMock.mockReset();
  state.authorised = true;
  state.linked.clear();
  // A fresh linked person per case, so the rate limiter starts at zero.
  number = String(966500000000 + ++next);
  state.linked.set(number, `user-${next}`);
});

describe("POST /api/channels/whatsapp/voice", () => {
  it("refuses a call without the channel token, without transcribing", async () => {
    state.authorised = false;
    expect((await POST(voiceNote({ whatsappUserId: number, file: OGG() }))).status).toBe(401);
    expect(transcribeMock).not.toHaveBeenCalled();
  });

  it("returns an Arabic voice note as Arabic text", async () => {
    transcribeMock.mockResolvedValue({ ok: true, text: "مرحبا", language: "ar", direction: "rtl" });
    const response = await POST(voiceNote({ whatsappUserId: number, file: OGG() }));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ text: "مرحبا", language: "ar", direction: "rtl" });
    expect(transcribeMock.mock.calls[0][0].mimeType).toBe("audio/ogg");
  });

  it("takes the type n8n passes when the file has none", async () => {
    transcribeMock.mockResolvedValue({ ok: true, text: "hi", language: "en", direction: "ltr" });
    const bare = new Blob([new Uint8Array(8)]);
    const response = await POST(voiceNote({ whatsappUserId: number, file: bare, mimeType: "audio/ogg; codecs=opus" }));
    expect(response.status).toBe(200);
  });

  it("answers 404 for a number that is not linked", async () => {
    const response = await POST(voiceNote({ whatsappUserId: "966599999999", file: OGG() }));
    expect(response.status).toBe(404);
    expect(transcribeMock).not.toHaveBeenCalled();
  });

  it("refuses a bad number or a missing file", async () => {
    expect((await POST(voiceNote({ whatsappUserId: "+9665", file: OGG() }))).status).toBe(400);
    expect((await POST(voiceNote({ whatsappUserId: number }))).status).toBe(400);
  });

  it("refuses a format that is not audio", async () => {
    const pdf = new Blob(["%PDF"], { type: "application/pdf" });
    expect((await POST(voiceNote({ whatsappUserId: number, file: pdf }))).status).toBe(415);
  });

  it("passes on that nothing was heard, or that the service is busy", async () => {
    transcribeMock.mockResolvedValueOnce({ ok: false, reason: "no_speech" });
    const quiet = await POST(voiceNote({ whatsappUserId: number, file: OGG() }));
    expect(quiet.status).toBe(422);
    expect((await quiet.json()).error).toBe("no_speech");

    transcribeMock.mockResolvedValueOnce({ ok: false, reason: "unavailable" });
    expect((await POST(voiceNote({ whatsappUserId: number, file: OGG() }))).status).toBe(503);
  });

  it("limits how many voice notes one person can send", async () => {
    transcribeMock.mockResolvedValue({ ok: true, text: "x", language: "en", direction: "ltr" });
    let last = 200;
    for (let i = 0; i < 21; i++) last = (await POST(voiceNote({ whatsappUserId: number, file: OGG() }))).status;
    expect(last).toBe(429);
  });
});
