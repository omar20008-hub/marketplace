import { inflateRawSync } from "node:zlib";

/**
 * Text out of Word (.docx), Excel (.xlsx) and PowerPoint (.pptx) files.
 *
 * These are zip archives of XML. Rather than take a dependency for a few well-known
 * parts, this reads the zip directly (stored and deflated entries, no ZIP64, no
 * encryption) and pulls the text out of the parts that hold it. The archive is
 * untrusted, so every size is capped: a small file that inflates to gigabytes
 * ("zip bomb") is refused, never expanded.
 */

export const DOCX = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
export const XLSX = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
export const PPTX = "application/vnd.openxmlformats-officedocument.presentationml.presentation";
export const OFFICE_TYPES = new Set([DOCX, XLSX, PPTX]);

const MAX_ENTRIES = 5_000;
const MAX_ENTRY_BYTES = 40 * 1024 * 1024;
const MAX_TOTAL_BYTES = 150 * 1024 * 1024;
const MAX_SHEET_ROWS = 50_000;

export class OfficeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OfficeError";
  }
}

// ------------------------------------------------------------------- zip

type Entry = { method: number; compressed: number; size: number; offset: number };

function findEntries(buf: Buffer): Map<string, Entry> {
  // End of central directory: the last 22+ bytes, searched backwards past a comment.
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 22 - 65_535); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new OfficeError("Not a valid Office file.");
  const count = buf.readUInt16LE(eocd + 10);
  let pos = buf.readUInt32LE(eocd + 16);
  if (count === 0xffff || pos === 0xffffffff) throw new OfficeError("This archive is too large to read.");
  if (count > MAX_ENTRIES) throw new OfficeError("This archive holds too many parts.");

  const entries = new Map<string, Entry>();
  for (let n = 0; n < count; n++) {
    if (pos + 46 > buf.length || buf.readUInt32LE(pos) !== 0x02014b50) throw new OfficeError("Not a valid Office file.");
    const flags = buf.readUInt16LE(pos + 8);
    const method = buf.readUInt16LE(pos + 10);
    const compressed = buf.readUInt32LE(pos + 20);
    const size = buf.readUInt32LE(pos + 24);
    const nameLen = buf.readUInt16LE(pos + 28);
    const extraLen = buf.readUInt16LE(pos + 30);
    const commentLen = buf.readUInt16LE(pos + 32);
    const offset = buf.readUInt32LE(pos + 42);
    const name = buf.toString("utf8", pos + 46, pos + 46 + nameLen);
    if (flags & 1) throw new OfficeError("This file is password protected.");
    entries.set(name, { method, compressed, size, offset });
    pos += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}

class Zip {
  private readonly entries: Map<string, Entry>;
  private total = 0;

  constructor(private readonly buf: Buffer) {
    this.entries = findEntries(buf);
  }

  names(): string[] {
    return [...this.entries.keys()];
  }

  /** The text of one part, or null when the archive has none by that name. */
  text(name: string): string | null {
    const entry = this.entries.get(name);
    if (!entry) return null;
    if (entry.size > MAX_ENTRY_BYTES) throw new OfficeError("A part of this file is too large to read.");
    const at = entry.offset;
    if (at + 30 > this.buf.length || this.buf.readUInt32LE(at) !== 0x04034b50) throw new OfficeError("Not a valid Office file.");
    const start = at + 30 + this.buf.readUInt16LE(at + 26) + this.buf.readUInt16LE(at + 28);
    const raw = this.buf.subarray(start, start + entry.compressed);
    let data: Buffer;
    if (entry.method === 0) data = raw;
    else if (entry.method === 8) {
      try {
        data = inflateRawSync(raw, { maxOutputLength: MAX_ENTRY_BYTES });
      } catch {
        throw new OfficeError("A part of this file is too large or damaged to read.");
      }
    } else throw new OfficeError("This file uses a compression that is not supported.");
    this.total += data.length;
    if (this.total > MAX_TOTAL_BYTES) throw new OfficeError("This file is too large to read.");
    return data.toString("utf8");
  }
}

// ------------------------------------------------------------------- xml

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };

function decode(text: string): string {
  return text.replace(/&(#x[0-9a-fA-F]+|#\d+|[a-z]+);/g, (whole, body: string) => {
    if (body[0] === "#") {
      const code = body[1] === "x" || body[1] === "X" ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10);
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : "";
    }
    return ENTITIES[body] ?? whole;
  });
}

function attr(tag: string, name: string): string | null {
  const m = new RegExp(`\\s${name}="([^"]*)"`).exec(tag);
  return m ? decode(m[1]) : null;
}

const byNumber = (a: string, b: string) => (Number(/(\d+)\.xml$/.exec(a)?.[1]) || 0) - (Number(/(\d+)\.xml$/.exec(b)?.[1]) || 0);

// ------------------------------------------------------------------ docx

/** Paragraphs as lines; a table row as its cells joined with " | ". */
function wordLines(xml: string): string[] {
  const lines: string[] = [];
  const token = /<w:tr[\s>]|<\/w:tr>|<w:tc[\s>]|<\/w:tc>|<\/w:p>|<w:t(?:\s[^>]*)?>[^<]*<\/w:t>|<w:tab\/>|<w:br\/>|<w:cr\/>/g;
  let paragraph = "";
  let cell: string[] = [];
  let row: string[] = [];
  let tableDepth = 0;

  for (const match of xml.matchAll(token)) {
    const t = match[0];
    if (t.startsWith("<w:tr")) {
      tableDepth++;
      if (tableDepth === 1) row = [];
    } else if (t === "</w:tr>") {
      if (tableDepth === 1 && row.some(Boolean)) lines.push(row.join(" | "));
      tableDepth = Math.max(0, tableDepth - 1);
    } else if (t.startsWith("<w:tc")) {
      if (tableDepth === 1) cell = [];
    } else if (t === "</w:tc>") {
      if (tableDepth === 1) row.push(cell.join(" ").trim());
    } else if (t === "</w:p>") {
      const text = paragraph.trim();
      paragraph = "";
      if (!text) continue;
      if (tableDepth > 0) cell.push(text);
      else lines.push(text);
    } else if (t === "<w:tab/>") paragraph += "\t";
    else if (t === "<w:br/>" || t === "<w:cr/>") paragraph += "\n";
    else paragraph += decode(t.replace(/^<w:t[^>]*>|<\/w:t>$/g, ""));
  }
  return lines;
}

function readDocx(zip: Zip): string {
  const parts = ["word/document.xml", "word/footnotes.xml", "word/endnotes.xml"];
  const out: string[] = [];
  for (const part of parts) {
    const xml = zip.text(part);
    if (xml) out.push(...wordLines(xml));
  }
  return out.join("\n\n");
}

// ------------------------------------------------------------------ pptx

function slideLines(xml: string): string[] {
  const lines: string[] = [];
  for (const p of xml.matchAll(/<a:p[\s>][\s\S]*?<\/a:p>/g)) {
    let text = "";
    for (const m of p[0].matchAll(/<a:t(?:\s[^>]*)?>([^<]*)<\/a:t>|<a:br\s*\/>/g)) {
      text += m[1] === undefined ? "\n" : decode(m[1]);
    }
    if (text.trim()) lines.push(text.trim());
  }
  return lines;
}

function readPptx(zip: Zip): string {
  const slides = zip.names().filter((n) => /^ppt\/slides\/slide\d+\.xml$/.test(n)).sort(byNumber);
  const out: string[] = [];
  slides.forEach((name, index) => {
    const lines = slideLines(zip.text(name) ?? "");
    // The speaker notes are the slide's own relationship, not whatever shares its number.
    const rels = zip.text(name.replace("ppt/slides/", "ppt/slides/_rels/") + ".rels") ?? "";
    const noteTarget = [...rels.matchAll(/<Relationship\s[^>]*>/g)]
      .map((m) => attr(m[0], "Target"))
      .find((t) => t && /notesSlides\/notesSlide\d+\.xml$/.test(t));
    const noteXml = noteTarget ? zip.text(`ppt/notesSlides/${noteTarget.split("/").pop()}`) : null;
    const noteLines = noteXml ? slideLines(noteXml).filter((l) => !/^\d+$/.test(l)) : [];
    if (lines.length === 0 && noteLines.length === 0) return;
    out.push([`## Slide ${index + 1}`, ...lines, ...(noteLines.length ? ["Notes:", ...noteLines] : [])].join("\n"));
  });
  return out.join("\n\n");
}

// ------------------------------------------------------------------ xlsx

function sharedStrings(xml: string | null): string[] {
  if (!xml) return [];
  return [...xml.matchAll(/<si(?:\s[^>]*)?>([\s\S]*?)<\/si>/g)].map((si) =>
    [...si[1].replace(/<rPh[\s\S]*?<\/rPh>/g, "").matchAll(/<t(?:\s[^>]*)?>([^<]*)<\/t>/g)].map((t) => decode(t[1])).join(""),
  );
}

function sheetTargets(zip: Zip): { name: string; part: string }[] {
  const workbook = zip.text("xl/workbook.xml") ?? "";
  const rels = new Map<string, string>();
  for (const m of (zip.text("xl/_rels/workbook.xml.rels") ?? "").matchAll(/<Relationship\s[^>]*>/g)) {
    const id = attr(m[0], "Id");
    const target = attr(m[0], "Target");
    if (id && target) rels.set(id, target.startsWith("/") ? target.slice(1) : `xl/${target}`);
  }
  const sheets: { name: string; part: string }[] = [];
  for (const m of workbook.matchAll(/<sheet\s[^>]*>/g)) {
    const name = attr(m[0], "name");
    const id = attr(m[0], "r:id");
    const part = id ? rels.get(id) : undefined;
    if (name && part && zip.names().includes(part)) sheets.push({ name, part });
  }
  if (sheets.length > 0) return sheets;
  // No usable workbook map: the sheet parts in order.
  return zip.names().filter((n) => /^xl\/worksheets\/sheet\d+\.xml$/.test(n)).sort(byNumber).map((part, i) => ({ name: `Sheet${i + 1}`, part }));
}

function sheetRows(xml: string, strings: string[]): string[] {
  const rows: string[] = [];
  for (const r of xml.matchAll(/<row(?:\s[^>]*)?>([\s\S]*?)<\/row>/g)) {
    if (rows.length >= MAX_SHEET_ROWS) break;
    const cells: string[] = [];
    for (const c of r[1].matchAll(/<c(\s[^>]*?)?(?:\/>|>([\s\S]*?)<\/c>)/g)) {
      const body = c[2];
      if (!body) continue;
      const type = attr(`<c${c[1] ?? ""}>`, "t");
      let value: string | null = null;
      if (type === "inlineStr") {
        value = [...body.matchAll(/<t(?:\s[^>]*)?>([^<]*)<\/t>/g)].map((t) => decode(t[1])).join("");
      } else {
        const v = /<v>([^<]*)<\/v>/.exec(body)?.[1];
        if (v === undefined) continue;
        if (type === "s") value = strings[Number(v)] ?? "";
        else if (type === "b") value = v === "1" ? "TRUE" : "FALSE";
        else if (type === "e") value = null; // an error value (#N/A, #DIV/0!) says nothing
        else value = decode(v);
      }
      if (value !== null && value.trim() !== "") cells.push(value.trim());
    }
    if (cells.length > 0) rows.push(cells.join(" | "));
  }
  return rows;
}

function readXlsx(zip: Zip): string {
  const strings = sharedStrings(zip.text("xl/sharedStrings.xml"));
  const out: string[] = [];
  for (const { name, part } of sheetTargets(zip)) {
    const rows = sheetRows(zip.text(part) ?? "", strings);
    if (rows.length > 0) out.push([`## Sheet: ${name}`, ...rows].join("\n"));
  }
  return out.join("\n\n");
}

// ---------------------------------------------------------------- public

/** The text of a Word, Excel or PowerPoint file; throws OfficeError for one that cannot be read. */
export function extractOfficeText(data: Uint8Array, mimeType: string): string {
  const zip = new Zip(Buffer.from(data.buffer, data.byteOffset, data.byteLength));
  if (mimeType === DOCX) return readDocx(zip);
  if (mimeType === XLSX) return readXlsx(zip);
  if (mimeType === PPTX) return readPptx(zip);
  throw new OfficeError("Not an Office file type.");
}
