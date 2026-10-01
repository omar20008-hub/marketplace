import "server-only";
import { DriveError } from "@/lib/drive";
import { EmbeddingError } from "@/lib/embeddings";
import { GoogleAuthError } from "@/lib/google-oauth";

/**
 * What kind of failure a job had, as a short stable word for logs and counts.
 *
 * Only the kind. An error's message can quote a query, a value or a file's
 * content, so it is read here to decide a category and then dropped: nothing this
 * returns can contain anything but a word from the list below (or an error class
 * name reduced to letters).
 */

const status = (message: string) => /answered (\d{3})/.exec(message)?.[1];

export function classifyJobError(error: unknown): string {
  if (error instanceof EmbeddingError) {
    const code = status(error.message);
    if (code === "429") return "embeddings_rate_limit";
    if (code?.startsWith("5")) return "embeddings_server_error";
    if (code) return `embeddings_http_${code}`;
    if (/request failed/i.test(error.message)) return "embeddings_network";
    if (/GEMINI_API_KEY/.test(error.message)) return "embeddings_not_configured";
    return "embeddings_error";
  }

  if (error instanceof DriveError) {
    if (error.status === 429) return "drive_rate_limit";
    if (error.status === 401) return "drive_unauthorized";
    if (error.status === 403) return "drive_forbidden";
    if (error.status === 0) return "drive_network";
    if (error.status >= 500) return "drive_server_error";
    return `drive_http_${error.status}`;
  }

  if (error instanceof GoogleAuthError) return "google_auth";

  if (error instanceof Error) {
    const text = `${error.name} ${error.message}`;
    if (/invalid byte sequence|0x00|22021/i.test(text)) return "nul_byte_in_text";
    if (/pdf|password|encrypted|PasswordException|FormatError/i.test(text)) return "pdf_parse_error";
    if (/timeout|timed out|ETIMEDOUT|AbortError/i.test(text)) return "timeout";
    if (/ECONNRESET|ECONNREFUSED|ENOTFOUND|fetch failed/i.test(text)) return "network";
    if (error.name.startsWith("PrismaClient")) {
      const code = (error as { code?: unknown }).code;
      return typeof code === "string" && /^P\d{4}$/.test(code) ? `database_error_${code}` : "database_error";
    }
    return `error_${error.name.replace(/[^A-Za-z0-9]/g, "") || "Unknown"}`;
  }
  return "unknown";
}

/** A file or folder name made safe to put on one log line: no control characters, one line, bounded. */
export function logName(name: string): string {
  const flat = name.replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim();
  return flat.length > 120 ? `${flat.slice(0, 117)}...` : flat;
}

import type { RetryInfo } from "./queue";

/** Whether this failure is a rate limit, and how long the service said to wait. */
export function retryInfoOf(error: unknown): RetryInfo {
  if (error instanceof EmbeddingError && /answered 429/.test(error.message)) {
    return { rateLimited: true, retryAfterSeconds: error.limit?.retryAfterSeconds };
  }
  if (error instanceof DriveError && error.status === 429) return { rateLimited: true };
  return {};
}

/**
 * What the Files page says, in words a person can act on, for a failure of this
 * kind. Null means there is nothing better than the raw reason. Still no content:
 * the text depends only on the kind.
 */
export function friendlyJobError(type: string, gaveUp: boolean): string | null {
  switch (type) {
    case "embeddings_rate_limit":
      return gaveUp
        ? "The embedding service kept limiting requests (rate limit or daily quota). Press Retry later, or raise the quota."
        : "The embedding service is limiting requests (rate limit or daily quota). Retrying automatically.";
    case "embeddings_server_error":
    case "embeddings_network":
      return gaveUp
        ? "The embedding service could not be reached. Press Retry later."
        : "The embedding service is not responding. Retrying automatically.";
    case "drive_rate_limit":
      return gaveUp
        ? "Google Drive kept limiting requests. Press Retry later."
        : "Google Drive is limiting requests. Retrying automatically.";
    case "nul_byte_in_text":
      return gaveUp ? "The file contains characters that cannot be stored." : null;
    case "pdf_parse_error":
      return gaveUp ? "This PDF could not be read (damaged, protected, or not text)." : null;
    default:
      return gaveUp ? null : "Retrying after a temporary problem.";
  }
}
