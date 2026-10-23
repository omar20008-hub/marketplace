/**
 * Speech to text for the chat box, with the language decided by the audio itself.
 * The person does not pick a language: the model hears which one is spoken, writes
 * the words in that language and says which language it was. Nothing is
 * translated. The same function is meant for voice notes from the chat channels.
 *
 * Provider-neutral at the edge: callers get { text, language }, and only this file
 * knows Gemini's wire format.
 */

export const MAX_AUDIO_BYTES = 10 * 1024 * 1024;
export const MAX_TRANSCRIPT_CHARS = 4000;

/** Containers a browser records into, and the ones the model reads. Parameters such as codecs are dropped first. */
export const AUDIO_TYPES = new Set([
  "audio/webm",
  "audio/ogg",
  "audio/mp4",
  "audio/mpeg",
  "audio/mp3",
  "audio/aac",
  "audio/wav",
  "audio/x-wav",
  "audio/flac",
]);

export function baseAudioType(mimeType: string): string | null {
  const base = mimeType.split(";")[0].trim().toLowerCase();
  return AUDIO_TYPES.has(base) ? base : null;
}

const RTL = new Set(["ar", "fa", "he", "ur", "ps", "yi", "ckb", "sd", "dv"]);

/** The writing direction for a language code: Arabic, Persian, Hebrew and the like run right to left. */
export function directionOf(language: string): "rtl" | "ltr" {
  return RTL.has(language.split("-")[0].toLowerCase()) ? "rtl" : "ltr";
}

export type Transcript = { text: string; language: string; direction: "rtl" | "ltr" };

export type TranscribeResult =
  | ({ ok: true } & Transcript)
  | { ok: false; reason: "no_speech" | "unavailable" | "failed" };

const ENDPOINT = "https://generativelanguage.googleapis.com/v1beta";
const TIMEOUT_MS = 60_000;

const PROMPT = [
  "Transcribe the speech in this audio exactly as it is spoken.",
  "Write it in the language it is spoken in. Do not translate it, do not answer it, and do not add anything.",
  "If more than one language is spoken, keep each part in its own language.",
  "Return `language` as the BCP-47 code of the main spoken language (for example ar, en, fr, ur) and `text` as the words.",
  "If there is no speech, return an empty `text` and `language` und.",
].join(" ");

class Unavailable extends Error {}

type GeminiResponse = {
  candidates?: { content?: { parts?: { text?: string }[] } }[];
};

function parseTranscript(body: GeminiResponse): { text: string; language: string } | null {
  const raw = body.candidates?.[0]?.content?.parts?.map((part) => part.text ?? "").join("") ?? "";
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  const value = parsed as { text?: unknown; language?: unknown } | null;
  if (!value || typeof value.text !== "string") return null;
  const language =
    typeof value.language === "string" && /^[A-Za-z]{2,3}(-[A-Za-z0-9]{2,8})*$/.test(value.language.trim())
      ? value.language.trim().toLowerCase()
      : "und";
  return { text: value.text.trim().slice(0, MAX_TRANSCRIPT_CHARS), language };
}

async function askModel(
  model: string,
  apiKey: string,
  audio: Uint8Array,
  mimeType: string,
  fetchImpl: typeof fetch,
): Promise<{ text: string; language: string } | null> {
  let response: Response;
  try {
    response = await fetchImpl(`${ENDPOINT}/models/${model}:generateContent`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-goog-api-key": apiKey },
      body: JSON.stringify({
        contents: [
          {
            role: "user",
            parts: [
              { inlineData: { mimeType, data: Buffer.from(audio).toString("base64") } },
              { text: PROMPT },
            ],
          },
        ],
        generationConfig: {
          temperature: 0,
          responseMimeType: "application/json",
          responseSchema: {
            type: "OBJECT",
            properties: { language: { type: "STRING" }, text: { type: "STRING" } },
            required: ["language", "text"],
          },
        },
      }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (error) {
    throw new Unavailable((error as Error).message);
  }

  if (response.status === 429 || response.status >= 500) throw new Unavailable(`Gemini answered ${response.status}`);
  if (!response.ok) {
    console.error(`Transcription refused by ${model}: ${response.status}`);
    return null;
  }
  return parseTranscript((await response.json()) as GeminiResponse);
}

export async function transcribe({
  audio,
  mimeType,
  apiKey,
  models,
  fetchImpl = fetch,
}: {
  audio: Uint8Array;
  mimeType: string;
  apiKey: string;
  /** Tried in order; the next one is used only when the current one is unavailable. */
  models: readonly string[];
  fetchImpl?: typeof fetch;
}): Promise<TranscribeResult> {
  if (!apiKey) return { ok: false, reason: "unavailable" };

  for (const model of models) {
    try {
      const result = await askModel(model, apiKey, audio, mimeType, fetchImpl);
      if (!result) return { ok: false, reason: "failed" };
      if (!result.text) return { ok: false, reason: "no_speech" };
      return { ok: true, ...result, direction: directionOf(result.language) };
    } catch (error) {
      if (!(error instanceof Unavailable)) throw error;
      console.error(`Transcription model ${model} unavailable: ${error.message}`);
    }
  }
  return { ok: false, reason: "unavailable" };
}
