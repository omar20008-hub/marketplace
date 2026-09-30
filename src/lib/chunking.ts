/**
 * Cuts a document into passages small enough to embed and large enough to mean
 * something. Paragraph-aware: it packs whole paragraphs up to the target size,
 * splits an oversized one on sentence ends, and only as a last resort mid-word.
 * Consecutive chunks share a tail so an answer that straddles a boundary is
 * still found whole in one of them.
 */

export const CHUNK_TARGET = 1200;
export const CHUNK_OVERLAP = 150;

function splitLong(paragraph: string, target: number): string[] {
  const sentences = paragraph.match(/[^.!?؟。\n]+[.!?؟。]*\s*/g) ?? [paragraph];
  const out: string[] = [];
  let current = "";
  for (const sentence of sentences) {
    if (sentence.length > target) {
      if (current) out.push(current);
      current = "";
      for (let i = 0; i < sentence.length; i += target) out.push(sentence.slice(i, i + target));
      continue;
    }
    if (current.length + sentence.length > target && current) {
      out.push(current);
      current = "";
    }
    current += sentence;
  }
  if (current) out.push(current);
  return out;
}

export function chunkText(
  input: string,
  { target = CHUNK_TARGET, overlap = CHUNK_OVERLAP } = {},
): string[] {
  const text = input.replace(/\r\n?/g, "\n").replace(/[ \t]+\n/g, "\n").trim();
  if (!text) return [];

  const pieces = text
    .split(/\n{2,}/)
    .map((piece) => piece.trim())
    .filter(Boolean)
    .flatMap((piece) => (piece.length > target ? splitLong(piece, target) : [piece]));

  const chunks: string[] = [];
  let current = "";
  for (const piece of pieces) {
    if (current && current.length + piece.length + 2 > target) {
      chunks.push(current.trim());
      const tail = current.slice(Math.max(0, current.length - overlap));
      // Start the overlap at a word boundary rather than mid-word.
      current = tail.slice(tail.search(/\s/) + 1 || 0);
    }
    current = current ? `${current}\n\n${piece}` : piece;
  }
  if (current.trim()) chunks.push(current.trim());
  return chunks.filter((chunk) => chunk.length > 0);
}
