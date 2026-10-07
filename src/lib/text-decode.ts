/**
 * Bytes of a text file as a string. Drive hands over the raw bytes, and reading them
 * as UTF-8 regardless turns a file saved by Excel for Windows (Arabic "CSV
 * (Comma delimited)" is Windows-1256, not UTF-8) into a run of U+FFFD, and a
 * "Unicode text" file (UTF-16) into NUL-separated letters.
 *
 *   BOM  → UTF-8 / UTF-16LE / UTF-16BE as marked
 *   else → UTF-8 if the bytes are valid UTF-8
 *   else → Windows-1256 when what it decodes to is mostly Arabic, Windows-1252 otherwise
 */

const ARABIC = /[؀-ۿ]/g;
const NON_ASCII = /[^\u0000-\u007F]/g;

export function decodeText(bytes: Uint8Array): string {
  if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
    return new TextDecoder("utf-8").decode(bytes.subarray(3));
  }
  if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe) {
    return new TextDecoder("utf-16le").decode(bytes.subarray(2));
  }
  if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) {
    return new TextDecoder("utf-16be").decode(bytes.subarray(2));
  }
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    // Not UTF-8: an old single-byte encoding.
  }
  const arabic = new TextDecoder("windows-1256").decode(bytes);
  const letters = arabic.match(ARABIC)?.length ?? 0;
  const nonAscii = arabic.match(NON_ASCII)?.length ?? 0;
  if (nonAscii > 0 && letters / nonAscii >= 0.5) return arabic;
  return new TextDecoder("windows-1252").decode(bytes);
}
