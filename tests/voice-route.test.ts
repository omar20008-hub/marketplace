import { beforeEach, describe, expect, it, vi } from "vitest";

/** POST /api/voice/transcribe: who may call it, what it accepts, and what it answers. */

const state = vi.hoisted(() => ({ user: null as { id: string } | null }));
const transcribeMock = vi.hoisted(() => vi.fn());

vi.mock("@/lib/auth", () => ({ currentUser: async () => state.user }));
vi.mock("@/server/voice/transcribe", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/server/voice/transcribe")>();
  return { ...actual, transcribe: transcribeMock };
});

const { POST } = await import("@/app/api/voice/transcribe/route");

let userCount = 0;

function upload(file: Blob | null, name = "recording.wav", address?: string) {
  const form = new FormData();
  if (file) form.append("audio", file, name);
  return new Request("http://localhost/api/voice/transcribe", {
    method: "POST",
    body: form,
    headers: address ? { "x-forwarded-for": address } : {},
  });
}

const WAV = () => new Blob([new Uint8Array(64)], { type: "audio/wav" });

beforeEach(() => {
  transcribeMock.mockReset();
  // A fresh user per case, so the rate limiter's count starts at zero.
  state.user = { id: `voice-user-${++userCount}` };
});

describe("POST /api/voice/transcribe", () => {
  it("transcribes for a guest too, since the guest chat has the microphone", async () => {
    state.user = null;
    transcribeMock.mockResolvedValue({ ok: true, text: "hello", language: "en", direction: "ltr" });
    const response = await POST(upload(WAV(), "recording.wav", "203.0.113.1"));
    expect(response.status).toBe(200);
    expect((await response.json()).text).toBe("hello");
  });

  it("limits a guest more tightly than a signed-in person, per address", async () => {
    state.user = null;
    transcribeMock.mockResolvedValue({ ok: true, text: "x", language: "en", direction: "ltr" });
    const statuses: number[] = [];
    for (let i = 0; i < 11; i++) statuses.push((await POST(upload(WAV(), "recording.wav", "203.0.113.2"))).status);
    expect(statuses.slice(0, 10).every((status) => status === 200)).toBe(true);
    expect(statuses[10]).toBe(429);
    // Another address has its own allowance.
    expect((await POST(upload(WAV(), "recording.wav", "203.0.113.3"))).status).toBe(200);
  });

  it("returns the text in the spoken language", async () => {
    transcribeMock.mockResolvedValue({ ok: true, text: "مرحبا", language: "ar", direction: "rtl" });
    const response = await POST(upload(WAV()));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ text: "مرحبا", language: "ar", direction: "rtl" });
    expect(transcribeMock.mock.calls[0][0].mimeType).toBe("audio/wav");
  });

  it("refuses a request with no recording", async () => {
    const response = await POST(upload(null));
    expect(response.status).toBe(400);
  });

  it("refuses a file that is not audio", async () => {
    const response = await POST(upload(new Blob(["x"], { type: "text/plain" }), "a.txt"));
    expect(response.status).toBe(415);
    expect(transcribeMock).not.toHaveBeenCalled();
  });

  it("says nothing was heard, as a 422", async () => {
    transcribeMock.mockResolvedValue({ ok: false, reason: "no_speech" });
    const response = await POST(upload(WAV()));
    expect(response.status).toBe(422);
    expect((await response.json()).reason).toBe("no_speech");
  });

  it("says the service is busy, as a 503", async () => {
    transcribeMock.mockResolvedValue({ ok: false, reason: "unavailable" });
    const response = await POST(upload(WAV()));
    expect(response.status).toBe(503);
  });

  it("limits how often one person can send recordings", async () => {
    transcribeMock.mockResolvedValue({ ok: true, text: "x", language: "en", direction: "ltr" });
    let last = 200;
    for (let i = 0; i < 21; i++) last = (await POST(upload(WAV()))).status;
    expect(last).toBe(429);
  });
});
