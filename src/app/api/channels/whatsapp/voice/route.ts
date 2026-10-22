import { NextResponse } from "next/server";
import { channelCallAuthorised } from "@/lib/channel-token";
import { env } from "@/lib/env";
import { hit } from "@/lib/rate-limit";
import { resolveChannelUser, WHATSAPP } from "@/server/channel-links";
import { baseAudioType, MAX_AUDIO_BYTES, transcribe } from "@/server/voice/transcribe";

/**
 * Called by n8n when a WhatsApp message is a voice note. n8n has already downloaded
 * the audio from WhatsApp (as it does for documents); it posts the bytes here as a
 * form (fields `whatsappUserId` and `file`, optionally `mimeType`). The words come
 * back in the language they were spoken in, never translated, as `text`, with
 * `language` and its writing `direction`. n8n then treats `text` as the message.
 *
 * 404 when the chat is not linked; the caller should then refuse to answer. The
 * audio is held in memory for the length of the call and never stored.
 */
export async function POST(request: Request) {
  if (!channelCallAuthorised(request)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const declared = Number(request.headers.get("content-length") ?? 0);
  if (declared > MAX_AUDIO_BYTES + 64 * 1024) {
    return NextResponse.json({ error: "too_large" }, { status: 413 });
  }

  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return NextResponse.json({ error: "Send the audio as a form upload." }, { status: 400 });
  }
  const whatsappUserId = form.get("whatsappUserId");
  const file = form.get("file");
  if (typeof whatsappUserId !== "string" || !/^\d{1,20}$/.test(whatsappUserId) || !(file instanceof File)) {
    return NextResponse.json({ error: "Bad request" }, { status: 400 });
  }
  if (file.size === 0) return NextResponse.json({ error: "empty" }, { status: 400 });
  if (file.size > MAX_AUDIO_BYTES) return NextResponse.json({ error: "too_large" }, { status: 413 });

  // WhatsApp voice notes are audio/ogg with Opus; n8n may pass the type separately.
  const mimeType = baseAudioType(String(form.get("mimeType") ?? "") || file.type);
  if (!mimeType) return NextResponse.json({ error: "unsupported_format" }, { status: 415 });

  const userId = await resolveChannelUser(WHATSAPP, whatsappUserId);
  if (!userId) return NextResponse.json({ error: "Not linked" }, { status: 404 });

  const limiter = hit(`voice:user:${userId}`, { limit: 20, windowMs: 10 * 60_000 });
  if (!limiter.ok) return NextResponse.json({ error: "rate_limited" }, { status: 429 });

  const result = await transcribe({
    audio: new Uint8Array(await file.arrayBuffer()),
    mimeType,
    apiKey: env.voice.geminiApiKey,
    models: env.voice.models,
  });
  if (!result.ok) {
    return NextResponse.json({ error: result.reason }, { status: result.reason === "unavailable" ? 503 : 422 });
  }
  return NextResponse.json({ text: result.text, language: result.language, direction: result.direction });
}

export const dynamic = "force-dynamic";
