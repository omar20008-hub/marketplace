import { deflateRawSync } from "node:zlib";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DOCX, extractOfficeText, OfficeError, PPTX, XLSX } from "@/lib/office-text";
import { isReadable, readFileText, skipReason } from "@/lib/drive";

/** A zip archive made of the given parts, deflated (or stored), so the reader meets the real format. */
function zip(parts: Record<string, string>, { store = false }: { store?: boolean } = {}): Uint8Array {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const [name, text] of Object.entries(parts)) {
    const raw = Buffer.from(text, "utf8");
    const data = store ? raw : deflateRawSync(raw);
    const nameBuf = Buffer.from(name, "utf8");
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(store ? 0 : 8, 8);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(store ? 0 : 8, 10);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(raw.length, 24);
    central.writeUInt16LE(nameBuf.length, 28);
    central.writeUInt32LE(offset, 42);
    locals.push(local, nameBuf, data);
    centrals.push(central, nameBuf);
    offset += local.length + nameBuf.length + data.length;
  }
  const centralBuf = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(Object.keys(parts).length, 8);
  end.writeUInt16LE(Object.keys(parts).length, 10);
  end.writeUInt32LE(centralBuf.length, 12);
  end.writeUInt32LE(offset, 16);
  return new Uint8Array(Buffer.concat([...locals, centralBuf, end]));
}

describe("types", () => {
  it("reads Word, Excel and PowerPoint, and still turns away the old binary formats", () => {
    for (const t of [DOCX, XLSX, PPTX]) {
      expect(isReadable(t)).toBe(true);
      expect(skipReason("x", t)).toBeNull();
    }
    expect(isReadable("application/msword")).toBe(false);
    expect(isReadable("application/vnd.ms-excel")).toBe(false);
    expect(skipReason("old.doc", "application/msword")).toMatch(/cannot be read/);
  });
});

describe("docx", () => {
  const document = `<?xml version="1.0"?><w:document><w:body>
    <w:p><w:r><w:t>Contract of sale</w:t></w:r></w:p>
    <w:p><w:r><w:t xml:space="preserve">Price: </w:t></w:r><w:r><w:t>5 &amp; 6 &lt;units&gt;</w:t></w:r><w:r><w:tab/><w:t>net</w:t></w:r></w:p>
    <w:p><w:r><w:t>مرحبا بالعالم</w:t></w:r></w:p>
    <w:tbl>
      <w:tr><w:tc><w:p><w:r><w:t>Item</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>Cost</w:t></w:r></w:p></w:tc></w:tr>
      <w:tr><w:tc><w:p><w:r><w:t>Pen</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>3</w:t></w:r></w:p><w:p><w:r><w:t>USD</w:t></w:r></w:p></w:tc></w:tr>
    </w:tbl>
    <w:p><w:r><w:t>After the table</w:t></w:r></w:p>
  </w:body></w:document>`;

  it("reads paragraphs, entities, tabs, Arabic and table rows", () => {
    const text = extractOfficeText(zip({ "word/document.xml": document }), DOCX);
    expect(text).toContain("Contract of sale");
    expect(text).toContain("Price: 5 & 6 <units>\tnet");
    expect(text).toContain("مرحبا بالعالم");
    expect(text).toContain("Item | Cost");
    expect(text).toContain("Pen | 3 USD");
    expect(text.indexOf("Item | Cost")).toBeLessThan(text.indexOf("After the table"));
  });

  it("reads stored (uncompressed) parts too, and footnotes", () => {
    const notes = `<w:footnotes><w:footnote><w:p><w:r><w:t>See annex B</w:t></w:r></w:p></w:footnote></w:footnotes>`;
    const text = extractOfficeText(zip({ "word/document.xml": document, "word/footnotes.xml": notes }, { store: true }), DOCX);
    expect(text).toContain("See annex B");
  });
});

describe("xlsx", () => {
  const files = {
    "xl/workbook.xml": `<workbook><sheets><sheet name="Sales 2026" sheetId="1" r:id="rId1"/><sheet name="Clients" sheetId="2" r:id="rId2"/></sheets></workbook>`,
    "xl/_rels/workbook.xml.rels": `<Relationships><Relationship Id="rId1" Type="x" Target="worksheets/sheet1.xml"/><Relationship Target="worksheets/sheet2.xml" Id="rId2" Type="x"/></Relationships>`,
    "xl/sharedStrings.xml": `<sst><si><t>Region</t></si><si><t>Total</t></si><si><r><t>Ri</t></r><r><t>yadh</t></r></si><si><t>أحمد</t></si></sst>`,
    "xl/worksheets/sheet1.xml": `<worksheet><sheetData>
      <row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c></row>
      <row r="2"><c r="A2" t="s"><v>2</v></c><c r="B2"><v>1250.5</v></c><c r="C2" t="b"><v>1</v></c><c r="D2" t="e"><v>#N/A</v></c><c r="E2" s="3"/></row>
      <row r="3"><c r="A3" t="inlineStr"><is><t>Jeddah</t></is></c><c r="B3"><f>SUM(B2:B2)</f><v>980</v></c></row>
    </sheetData></worksheet>`,
    "xl/worksheets/sheet2.xml": `<worksheet><sheetData><row r="1"><c r="A1" t="s"><v>3</v></c></row></sheetData></worksheet>`,
  };

  it("reads each sheet by name: shared strings, numbers, inline strings, booleans; skips errors and empty cells", () => {
    const text = extractOfficeText(zip(files), XLSX);
    expect(text).toContain("## Sheet: Sales 2026");
    expect(text).toContain("Region | Total");
    expect(text).toContain("Riyadh | 1250.5 | TRUE");
    expect(text).toContain("Jeddah | 980");
    expect(text).not.toContain("#N/A");
    expect(text).toContain("## Sheet: Clients\nأحمد");
  });

  it("falls back to the sheet parts in order when the workbook map is missing", () => {
    const { ["xl/workbook.xml"]: _w, ["xl/_rels/workbook.xml.rels"]: _r, ...rest } = files;
    void _w;
    void _r;
    const text = extractOfficeText(zip(rest), XLSX);
    expect(text).toContain("## Sheet: Sheet1");
    expect(text).toContain("## Sheet: Sheet2");
  });
});

describe("pptx", () => {
  const slide = (lines: string[]) =>
    `<p:sld><p:cSld><p:spTree>${lines.map((l) => `<p:sp><p:txBody><a:p><a:r><a:t>${l}</a:t></a:r></a:p></p:txBody></p:sp>`).join("")}</p:spTree></p:cSld></p:sld>`;

  it("reads slides in numeric order (slide10 after slide2) with their speaker notes", () => {
    const text = extractOfficeText(
      zip({
        "ppt/slides/slide2.xml": slide(["Second slide"]),
        "ppt/slides/slide10.xml": slide(["Tenth slide"]),
        "ppt/slides/slide1.xml": slide(["Title: Roadmap", "Q1 &amp; Q2"]),
        "ppt/slides/_rels/slide1.xml.rels": `<Relationships><Relationship Id="rId2" Type="n" Target="../notesSlides/notesSlide7.xml"/></Relationships>`,
        "ppt/notesSlides/notesSlide7.xml": slide(["Say this aloud", "1"]),
      }),
      PPTX,
    );
    expect(text.indexOf("Title: Roadmap")).toBeLessThan(text.indexOf("Second slide"));
    expect(text.indexOf("Second slide")).toBeLessThan(text.indexOf("Tenth slide"));
    expect(text).toContain("Q1 & Q2");
    expect(text).toContain("Notes:\nSay this aloud");
    expect(text).not.toMatch(/Notes:[\s\S]*\n1(\n|$)/);
  });
});

describe("bad archives", () => {
  it("refuses something that is not a zip, and a zip bomb", () => {
    expect(() => extractOfficeText(new Uint8Array([1, 2, 3, 4]), DOCX)).toThrow(OfficeError);
    expect(() => extractOfficeText(new TextEncoder().encode("plain text, not an archive at all, long enough to scan"), DOCX)).toThrow(/valid Office/);
    // 60 MB of zeros deflates to a few kilobytes: it must be refused, not expanded.
    const bomb = zip({ "word/document.xml": "0".repeat(60 * 1024 * 1024) });
    expect(bomb.length).toBeLessThan(200_000);
    expect(() => extractOfficeText(bomb, DOCX)).toThrow(/too large/);
  });
});

describe("reading from Drive", () => {
  afterEach(() => vi.unstubAllGlobals());
  const drive = (mimeType: string) => ({ id: "f1", name: "x", mimeType, revision: "r", webUrl: null, path: "", size: 1000 });

  it("downloads the file and returns its text", async () => {
    const body = zip({ "word/document.xml": "<w:document><w:p><w:r><w:t>Hello from Word</w:t></w:r></w:p></w:document>" });
    vi.stubGlobal("fetch", vi.fn(async () => new Response(Buffer.from(body))));
    expect(await readFileText("token", drive(DOCX))).toEqual({ ok: true, text: "Hello from Word" });
  });

  it("says so, rather than failing, for an empty or damaged file", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(Buffer.from(zip({ "word/document.xml": "<w:document></w:document>" })))));
    expect(await readFileText("token", drive(DOCX))).toEqual({ ok: false, reason: "The file has no text in it." });
    vi.stubGlobal("fetch", vi.fn(async () => new Response(Buffer.from([9, 9, 9, 9]))));
    expect(await readFileText("token", drive(XLSX))).toMatchObject({ ok: false, reason: expect.stringMatching(/valid Office/) });
  });
});
