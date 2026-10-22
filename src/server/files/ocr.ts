import "server-only";
import { env } from "@/lib/env";
import type { Ocr } from "@/lib/file-text";

/**
 * Reads the text in an image or a scanned PDF with Gemini, the same key and
 * models the chat already uses. Writes what is there, in its own language; when
 * an image has little or no text, a short description of it instead, so a photo
 * of a whiteboard and a photo of a product are both findable later.
 *
 * Returns null on any failure: a file whose text could not be read is still kept,
 * and the person is told it could not be read.
 */

const ENDPOINT = "https://generativelanguage.googleapis.com/v1beta";
const TIMEOUT_MS = 60_000;
const MAX_OCR_CHARS = 60_000;

const PROMPT = [
  "Extract all the text in this file exactly as written, in its original language. Do not translate or summarise it.",
  "Keep the reading order. Write tables as rows with cells separated by \" | \".",
  "If it is an image with little or no text, describe what it shows in two or three plain sentences instead.",
  "Return only the text, with no preface.",
].join(" ");

type GeminiResponse = { candidates?: { content?: { parts?: { text?: string }[] } }[] };

export async function ocrWithGemini(
  bytes: Uint8Array,
  mimeType: string,
  {
    apiKey = env.ocr.geminiApiKey,
    models = env.ocr.models,
    fetchImpl = fetch,
  }: { apiKey?: string; models?: readonly string[]; fetchImpl?: typeof fetch } = {},
): Promise<string | null> {
  if (!apiKey) return null;
  for (const model of models) {
    let response: Response;
    try {
      response = await fetchImpl(`${ENDPOINT}/models/${model}:generateContent`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-goog-api-key": apiKey },
        body: JSON.stringify({
          contents: [
            {
              role: "user",
              parts: [{ inlineData: { mimeType, data: Buffer.from(bytes).toString("base64") } }, { text: PROMPT }],
            },
          ],
          generationConfig: { temperature: 0 },
        }),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch (error) {
      console.error(`OCR model ${model} unreachable: ${(error as Error).name}`);
      continue;
    }
    // Busy or down: the next model may answer. Anything else will not get better.
    if (response.status === 429 || response.status >= 500) {
      console.error(`OCR model ${model} unavailable: ${response.status}`);
      continue;
    }
    if (!response.ok) {
      console.error(`OCR refused by ${model}: ${response.status}`);
      return null;
    }
    const body = (await response.json().catch(() => ({}))) as GeminiResponse;
    const text = body.candidates?.[0]?.content?.parts?.map((part) => part.text ?? "").join("").trim() ?? "";
    return text ? text.slice(0, MAX_OCR_CHARS) : null;
  }
  return null;
}

export const defaultOcr: Ocr = (bytes, mimeType) => ocrWithGemini(bytes, mimeType);
