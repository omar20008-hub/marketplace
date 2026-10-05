import "server-only";
import { createHash } from "node:crypto";
import { env } from "./env";

/**
 * Text → vector, behind one function so the provider can change without the
 * indexer or the retrieval endpoint noticing. The dimension is fixed by the
 * column (vector(768)); a provider that produces something else must be asked
 * for 768 or it does not belong here.
 */

export const EMBEDDING_DIMENSIONS = 768;
const BATCH = 25;

/** Longest a single embedding call will itself wait out a per-minute limit, in total, before handing the wait to the job queue. */
const MAX_INLINE_WAIT_SECONDS = 25;
const MAX_INLINE_RETRIES = 3;
/** A person is waiting on a question's embedding, so it waits far less than an indexing job does. */
const MAX_QUERY_WAIT_SECONDS = 8;

/** Overridable so tests need not really wait. */
export const embeddingsRuntime = {
  sleep: (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)),
};

export type EmbedTask = "document" | "query";

export class EmbeddingError extends Error {
  constructor(
    message: string,
    /** Rate limits and 5xx are worth retrying; a bad key or a bad request is not. */
    readonly retryable: boolean,
    /** For a 429: how long the API said to wait, and whether it is a per-minute or a per-day limit. */
    readonly limit?: { retryAfterSeconds?: number; quota?: "minute" | "day" },
  ) {
    super(message);
    this.name = "EmbeddingError";
  }
}

/**
 * What Gemini says about a 429: how long to wait (the Retry-After header, or the
 * RetryInfo detail in the body, "34s") and which quota ran out. The body is read
 * for those two facts only and is never put in an error message.
 */
export async function readRateLimit(
  response: Response,
): Promise<{ retryAfterSeconds?: number; quota?: "minute" | "day" }> {
  let retryAfterSeconds: number | undefined;
  const header = Number(response.headers.get("retry-after"));
  if (Number.isFinite(header) && header > 0) retryAfterSeconds = Math.ceil(header);

  let quota: "minute" | "day" | undefined;
  try {
    const body = JSON.parse((await response.text()).slice(0, 20_000)) as {
      error?: { details?: { "@type"?: string; retryDelay?: string; violations?: { quotaId?: string }[] }[] };
    };
    for (const detail of body.error?.details ?? []) {
      const delay = /^(\d+(?:\.\d+)?)s$/.exec(detail.retryDelay ?? "");
      if (delay && retryAfterSeconds === undefined) retryAfterSeconds = Math.ceil(Number(delay[1]));
      for (const violation of detail.violations ?? []) {
        if (/PerDay/i.test(violation.quotaId ?? "")) quota = "day";
        else if (!quota && /PerMinute/i.test(violation.quotaId ?? "")) quota = "minute";
      }
    }
  } catch {
    // Not JSON, or not the shape we know: the status alone is still a rate limit.
  }
  return { retryAfterSeconds, quota };
}

function normalise(vector: number[]): number[] {
  const norm = Math.sqrt(vector.reduce((sum, x) => sum + x * x, 0)) || 1;
  return vector.map((x) => x / norm);
}

/** Same text, same vector; shared words pull vectors together a little. */
function fakeEmbedding(text: string): number[] {
  const vector = new Array<number>(EMBEDDING_DIMENSIONS).fill(0);
  for (const word of text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []) {
    const hash = createHash("sha256").update(word).digest();
    vector[hash.readUInt16BE(0) % EMBEDDING_DIMENSIONS] += 1;
    vector[hash.readUInt16BE(2) % EMBEDDING_DIMENSIONS] -= 0.5;
  }
  return normalise(vector);
}

async function geminiBatch(texts: string[], task: EmbedTask): Promise<number[][]> {
  if (!env.embeddings.apiKey) {
    throw new EmbeddingError("GEMINI_API_KEY is not set.", false);
  }
  const model = `models/${env.embeddings.model}`;
  let response: Response;
  try {
    response = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/${model}:batchEmbedContents`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-goog-api-key": env.embeddings.apiKey,
        },
        body: JSON.stringify({
          requests: texts.map((text) => ({
            model,
            content: { parts: [{ text }] },
            taskType: task === "query" ? "RETRIEVAL_QUERY" : "RETRIEVAL_DOCUMENT",
            outputDimensionality: EMBEDDING_DIMENSIONS,
          })),
        }),
      },
    );
  } catch (error) {
    throw new EmbeddingError(`Embedding request failed: ${(error as Error).message}`, true);
  }

  if (!response.ok) {
    const retryable = response.status === 429 || response.status >= 500;
    const limit = response.status === 429 ? await readRateLimit(response) : undefined;
    throw new EmbeddingError(`Embedding API answered ${response.status}.`, retryable, limit);
  }
  const body = (await response.json()) as { embeddings?: { values: number[] }[] };
  if (body.embeddings?.length !== texts.length) {
    throw new EmbeddingError("Embedding API returned the wrong number of vectors.", true);
  }
  // Truncated (non-native-size) Gemini embeddings are not unit length.
  return body.embeddings.map((e) => normalise(e.values));
}

export async function embedTexts(texts: string[], task: EmbedTask): Promise<number[][]> {
  if (env.embeddings.driver === "fake") return texts.map(fakeEmbedding);
  const out: number[][] = [];
  let waited = 0;
  const maxWait = task === "query" ? MAX_QUERY_WAIT_SECONDS : MAX_INLINE_WAIT_SECONDS;
  for (let i = 0; i < texts.length; i += BATCH) {
    const batch = texts.slice(i, i + BATCH);
    for (let attempt = 0; ; attempt++) {
      try {
        out.push(...(await geminiBatch(batch, task)));
        break;
      } catch (error) {
        // A per-minute limit usually clears in seconds: wait it out here, within
        // reason, so a big file is not thrown back to the queue (and restarted)
        // for a pause that short. A daily limit, or a long wait, is the queue's job.
        const limit = error instanceof EmbeddingError ? error.limit : undefined;
        const wait = limit?.retryAfterSeconds ?? 5 * (attempt + 1);
        if (
          !(error instanceof EmbeddingError) ||
          !limit ||
          limit.quota === "day" ||
          attempt >= MAX_INLINE_RETRIES ||
          waited + wait > maxWait
        ) {
          throw error;
        }
        waited += wait;
        await embeddingsRuntime.sleep(wait * 1000);
      }
    }
  }
  return out;
}

/** pgvector's text form, for a `$1::vector` parameter. */
export function toVectorLiteral(vector: number[]): string {
  return `[${vector.join(",")}]`;
}

/**
 * Names the model behind the vectors being written and searched. Stored with
 * every indexed file, because vectors from different models live in different
 * spaces: comparing one to the other returns confident nonsense, not an error.
 */
export function embeddingTag(): string {
  return env.embeddings.driver === "fake" ? "fake" : `gemini:${env.embeddings.model}`;
}
