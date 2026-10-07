/**
 * Whether text pulled out of a file is unreadable: a PDF whose fonts have no
 * Unicode mapping, or a scan with a broken text layer, yields NUL bytes, control
 * characters, private-use code points and replacement characters instead of words.
 * Indexing that costs embedding quota and, worse, the garbage chunks answer
 * questions (each carries the file's name) ahead of a good copy of the same file.
 *
 * Deliberately conservative: only characters that are never part of ordinary prose
 * in any language count against it, and the share has to be large. Arabic, other
 * scripts, accents, digits, punctuation and emoji are all fine. (A text file that is
 * not UTF-8 is decoded by its own encoding first, see text-decode.ts, so it does
 * not arrive here as a run of replacement characters.)
 */

const MIN_VISIBLE_CHARS = 200;
const SAMPLE_CHARS = 30_000;
const UNREADABLE_SHARE = 0.2;

// NUL and the other C0/C1 controls (tab, newline and return are text), the
// replacement character, and private use. Symbols such as emoji are not counted:
// they are ordinary in chat exports and spreadsheets.
const SUSPECT = /[\u0000-\u0008\u000E-\u001F\u007F-\u009F�\p{Co}]/gu;

export function looksUnreadable(text: string): boolean {
  const sample = text.slice(0, SAMPLE_CHARS);
  // \s does not match NUL or the other controls, so those count as visible characters.
  const visible = sample.replace(/\s/g, "").length;
  if (visible < MIN_VISIBLE_CHARS) return false;
  const suspect = sample.match(SUSPECT)?.length ?? 0;
  return suspect / visible >= UNREADABLE_SHARE;
}

export const UNREADABLE_TEXT_REASON =
  "The text in this file is unreadable (a scan or an unusual font). Use a copy that has real text, such as an OCR version.";
