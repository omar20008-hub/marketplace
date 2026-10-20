import { NextResponse } from "next/server";
import { currentUser } from "@/lib/auth";
import { env } from "@/lib/env";
import { hit } from "@/lib/rate-limit";
import { baseAudioType, MAX_AUDIO_BYTES, transcribe } from "@/server/voice/transcribe";

/**
 * Turns a recording from the chat box into text, in the language it was spoken in.
 * Signed-in people only, and rate limited: every call spends the platform's Gemini
 * quota. The audio is held in memory for the length of the call and never stored.
 */

const MESSAGES = {
  no_speech: "Nothing was heard in the recording. Try again.",
  unavailable: "Voice input is busy right now. Try again in a moment.",
  failed: "The recording could not be written down. Try again.",
} as const;

export async function POST(request: Request) {
  const user = await currentUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const limiter = hit(`voice:${user.id}`, { limit: 20, windowMs: 10 * 60_000 });
  if (!limiter.ok) {
    return NextResponse.json(
      { error: "Too many recordings. Wait a moment and try again." },
      { status: 429, headers: { "retry-after": String(limiter.retryAfterSeconds) } },
    );
  }

  // Refuse an oversized body before reading it; the bytes are checked again below.
  const declared = Number(request.headers.get("content-length") ?? 0);
  if (declared > MAX_AUDIO_BYTES + 64 * 1024) {
    return NextResponse.json({ error: "The recording is too long." }, { status: 413 });
  }

  let file: FormDataEntryValue | null;
  try {
    file = (await request.formData()).get("audio");
  } catch {
    return NextResponse.json({ error: "Send the recording as a form upload." }, { status: 400 });
  }
  if (!(file instanceof File) || file.size === 0) {
    return NextResponse.json({ error: "No recording was sent." }, { status: 400 });
  }
  if (file.size > MAX_AUDIO_BYTES) {
    return NextResponse.json({ error: "The recording is too long." }, { status: 413 });
  }
  const mimeType = baseAudioType(file.type);
  if (!mimeType) {
    return NextResponse.json({ error: "That recording format is not supported." }, { status: 415 });
  }

  const result = await transcribe({
    audio: new Uint8Array(await file.arrayBuffer()),
    mimeType,
    apiKey: env.voice.geminiApiKey,
    models: env.voice.models,
  });

  if (!result.ok) {
    const status = result.reason === "unavailable" ? 503 : 422;
    return NextResponse.json({ error: MESSAGES[result.reason], reason: result.reason }, { status });
  }
  return NextResponse.json({ text: result.text, language: result.language, direction: result.direction });
}

export const dynamic = "force-dynamic";
