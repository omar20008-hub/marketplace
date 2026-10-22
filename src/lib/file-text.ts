import { extractText, getDocumentProxy } from "unpdf";
import { DOCX, extractOfficeText, OfficeError, PPTX, XLSX } from "./office-text";
import { decodeText } from "./text-decode";
import { sniffImage } from "./image-sniff";
import { storableText } from "./chunking";

/**
 * What a file a person attaches in a conversation is, and the text in it.
 *
 * The kind is decided from the bytes wherever they can tell (PDF, image, zip); the
 * name and the sender's type only choose between the Office formats, which are all
 * zips, and between the plain-text formats, which have no signature at all. A file
 * that claims to be text but holds binary is refused rather than read as noise.
 *
 * Images and PDFs without a text layer (scans) go to `ocr`, which the caller
 * supplies, so this file has no network in it.
 */

export const MAX_FILE_BYTES = 10 * 1024 * 1024;
/** Most text kept from one file. Enough for a long report; a book is cut. */
export const MAX_FILE_TEXT_CHARS = 200_000;

export type FileKind =
  | { kind: "pdf"; mime: "application/pdf"; label: "PDF" }
  | { kind: "office"; mime: string; label: "Word" | "Excel" | "PowerPoint" }
  | { kind: "image"; mime: string; label: "Image" }
  | { kind: "text"; mime: string; label: "Text" | "Markdown" | "JSON" | "CSV" };

const TEXT_TYPES: Record<string, { mime: string; label: "Text" | "Markdown" | "JSON" | "CSV" }> = {
  txt: { mime: "text/plain", label: "Text" },
  text: { mime: "text/plain", label: "Text" },
  log: { mime: "text/plain", label: "Text" },
  md: { mime: "text/markdown", label: "Markdown" },
  markdown: { mime: "text/markdown", label: "Markdown" },
  json: { mime: "application/json", label: "JSON" },
  csv: { mime: "text/csv", label: "CSV" },
  tsv: { mime: "text/tab-separated-values", label: "CSV" },
};

const OFFICE_BY_EXT: Record<string, { mime: string; label: "Word" | "Excel" | "PowerPoint" }> = {
  docx: { mime: DOCX, label: "Word" },
  xlsx: { mime: XLSX, label: "Excel" },
  pptx: { mime: PPTX, label: "PowerPoint" },
};

const OFFICE_BY_MIME: Record<string, { mime: string; label: "Word" | "Excel" | "PowerPoint" }> = {
  [DOCX]: OFFICE_BY_EXT.docx,
  [XLSX]: OFFICE_BY_EXT.xlsx,
  [PPTX]: OFFICE_BY_EXT.pptx,
};

const TEXT_BY_MIME: Record<string, keyof typeof TEXT_TYPES> = {
  "text/plain": "txt",
  "text/markdown": "md",
  "text/x-markdown": "md",
  "application/json": "json",
  "text/json": "json",
  "text/csv": "csv",
  "application/csv": "csv",
  "text/tab-separated-values": "tsv",
};

/** What the extensions in the file picker accept; the server decides again from the bytes. */
export const ACCEPTED_EXTENSIONS = [".pdf", ".docx", ".xlsx", ".pptx", ".txt", ".md", ".json", ".csv", ".jpg", ".jpeg", ".png", ".webp"];

function extensionOf(name: string): string {
  const match = /\.([A-Za-z0-9]{1,10})$/.exec(name.trim());
  return match ? match[1].toLowerCase() : "";
}

function isWebp(bytes: Uint8Array): boolean {
  return (
    bytes.length >= 12 &&
    String.fromCharCode(bytes[0], bytes[1], bytes[2], bytes[3]) === "RIFF" &&
    String.fromCharCode(bytes[8], bytes[9], bytes[10], bytes[11]) === "WEBP"
  );
}

/** Text has no NULs and few control characters; a binary file sent as ".txt" has many. */
function looksLikeText(bytes: Uint8Array): boolean {
  const sample = bytes.subarray(0, 8192);
  if (sample.length === 0) return false;
  // UTF-16 with a BOM is text even though half its bytes are NUL.
  if ((sample[0] === 0xff && sample[1] === 0xfe) || (sample[0] === 0xfe && sample[1] === 0xff)) return true;
  let control = 0;
  for (const byte of sample) {
    if (byte === 0) return false;
    if (byte < 0x09 || (byte > 0x0d && byte < 0x20)) control++;
  }
  return control / sample.length < 0.05;
}

/** The kind of a file, or null when it is not one that can be read. */
export function sniffFile(bytes: Uint8Array, name: string, declaredMime = ""): FileKind | null {
  if (bytes.length >= 5 && String.fromCharCode(...bytes.subarray(0, 5)) === "%PDF-") {
    return { kind: "pdf", mime: "application/pdf", label: "PDF" };
  }
  const image = sniffImage(bytes);
  if (image) return { kind: "image", mime: image.mime, label: "Image" };
  if (isWebp(bytes)) return { kind: "image", mime: "image/webp", label: "Image" };

  const ext = extensionOf(name);
  const mime = declaredMime.split(";")[0].trim().toLowerCase();

  if (bytes.length >= 4 && bytes[0] === 0x50 && bytes[1] === 0x4b && bytes[2] === 0x03 && bytes[3] === 0x04) {
    const office = OFFICE_BY_EXT[ext] ?? OFFICE_BY_MIME[mime];
    return office ? { kind: "office", ...office } : null;
  }

  const textType = TEXT_TYPES[ext] ?? (TEXT_BY_MIME[mime] ? TEXT_TYPES[TEXT_BY_MIME[mime]] : undefined);
  if ((textType || mime.startsWith("text/")) && looksLikeText(bytes)) {
    return { kind: "text", ...(textType ?? TEXT_TYPES.txt) };
  }
  return null;
}

/** Reads the text in an image or a scanned PDF; null when nothing could be read. */
export type Ocr = (bytes: Uint8Array, mimeType: string) => Promise<string | null>;

export type ExtractResult =
  | { ok: true; text: string; method: "text" | "pdf" | "office" | "ocr"; truncated: boolean }
  | { ok: false; reason: string };

function done(raw: string, method: "text" | "pdf" | "office" | "ocr"): ExtractResult {
  const text = storableText(raw).trim();
  if (!text) return { ok: false, reason: "No text could be read from the file." };
  return {
    ok: true,
    text: text.slice(0, MAX_FILE_TEXT_CHARS),
    method,
    truncated: text.length > MAX_FILE_TEXT_CHARS,
  };
}

/** The text of a file of a known kind. Never throws for a malformed file: it says why instead. */
export async function extractFileText(bytes: Uint8Array, kind: FileKind, ocr: Ocr): Promise<ExtractResult> {
  if (kind.kind === "text") {
    let text = decodeText(bytes);
    if (kind.label === "JSON") {
      // Indented JSON reads (and chunks) far better than one long line.
      try {
        text = JSON.stringify(JSON.parse(text), null, 2);
      } catch {
        // Not valid JSON: keep it as written.
      }
    }
    return done(text, "text");
  }

  if (kind.kind === "office") {
    try {
      return done(extractOfficeText(bytes, kind.mime), "office");
    } catch (error) {
      if (error instanceof OfficeError) return { ok: false, reason: error.message };
      return { ok: false, reason: "The file could not be read." };
    }
  }

  if (kind.kind === "pdf") {
    let text = "";
    try {
      // unpdf takes ownership of the buffer it is given, so it gets a copy.
      const pdf = await getDocumentProxy(new Uint8Array(bytes));
      text = (await extractText(pdf, { mergePages: true })).text;
    } catch {
      // A damaged or encrypted PDF: OCR may still read it.
    }
    if (text.trim().length >= 20) return done(text, "pdf");
    const scanned = await ocr(bytes, kind.mime);
    return scanned ? done(scanned, "ocr") : { ok: false, reason: "The PDF has no text layer and could not be read." };
  }

  const read = await ocr(bytes, kind.mime);
  return read ? done(read, "ocr") : { ok: false, reason: "No text could be read from the image." };
}
