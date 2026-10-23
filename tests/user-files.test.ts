import { deflateRawSync } from "node:zlib";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { DOCX, XLSX } from "@/lib/office-text";
import { extractFileText, sniffFile } from "@/lib/file-text";

/**
 * Files sent in a conversation (the platform chat and WhatsApp): which are read and
 * how, that they are kept in the sender's own space and nobody else's, that the
 * assistant gets their text with the message, and that a later message finds them.
 */

const viewer = vi.hoisted(() => ({ current: null as { id: string } | null }));
vi.mock("@/lib/auth", () => ({
  currentUser: async () => viewer.current,
  requireUser: async () => {
    if (!viewer.current) throw new Error("redirect:/login");
    return viewer.current;
  },
}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("next/navigation", () => ({
  redirect: (to: string) => {
    throw new Error(`redirect:${to}`);
  },
}));
const ocrCalls = vi.hoisted(() => [] as string[]);
vi.mock("@/server/files/ocr", () => ({
  defaultOcr: async (_bytes: Uint8Array, mimeType: string) => {
    ocrCalls.push(mimeType);
    return "فاتورة رقم 42 الإجمالي 990 ريال";
  },
}));
const chatCalls: { sessionId: string; chatInput: string }[] = [];
vi.mock("@/lib/n8n", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/n8n")>();
  return {
    ...actual,
    n8n: {
      ...actual.n8n,
      chat: async (input: { sessionId: string; chatInput: string }) => {
        chatCalls.push(input);
        return { output: "ok" };
      },
    },
  };
});

const { prisma } = await import("@/lib/db");
const files = await import("@/server/files/user-files");
const { POST: upload } = await import("@/app/api/files/route");
const { POST: whatsappFile } = await import("@/app/api/channels/whatsapp/files/route");
const { POST: whatsappContext } = await import("@/app/api/channels/whatsapp/context/route");
const { followUp } = await import("@/server/thread-actions");

const enc = (text: string) => new TextEncoder().encode(text);
const JPEG = Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, 0, 0x10, 0x4a, 0x46, 0x49, 0x46, 0, 1]);

function zip(parts: Record<string, string>): Uint8Array {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const [name, text] of Object.entries(parts)) {
    const raw = Buffer.from(text, "utf8");
    const data = deflateRawSync(raw);
    const nameBuf = Buffer.from(name, "utf8");
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(8, 8);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(8, 10);
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

const DOCX_BYTES = zip({
  "word/document.xml": `<?xml version="1.0"?><w:document><w:body><w:p><w:r><w:t>Lease agreement for the Riyadh office, rent 5000 per month</w:t></w:r></w:p></w:body></w:document>`,
});

/** A one-page PDF whose text layer says `text`, with a correct cross-reference table. */
function pdf(text: string): Uint8Array {
  const stream = `BT /F1 12 Tf 72 720 Td (${text}) Tj ET`;
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>",
    `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  ];
  let out = "%PDF-1.4\n";
  const offsets: number[] = [];
  objects.forEach((body, i) => {
    offsets.push(out.length);
    out += `${i + 1} 0 obj\n${body}\nendobj\n`;
  });
  const xref = out.length;
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const o of offsets) out += `${String(o).padStart(10, "0")} 00000 n \n`;
  out += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return enc(out);
}

async function user(email: string) {
  await prisma.plan.upsert({
    where: { id: "files-plan" },
    update: {},
    create: { id: "files-plan", name: "T", monthlyRuns: 100, storageBytes: BigInt(1), monthlyCredits: 0 },
  });
  return prisma.user.create({
    data: { email, name: "F", passwordHash: "x", initials: "F", planId: "files-plan" },
  });
}

const form = (bytes: Uint8Array, name: string, type = "") => {
  const body = new FormData();
  body.set("file", new File([Buffer.from(bytes)], name, { type }));
  return new Request("http://localhost/api/files", { method: "POST", body });
};

const channelHeaders = { "x-channel-token": "test-channel-token" };

async function wipe() {
  await prisma.userFile.deleteMany({});
  await prisma.mediaUpload.deleteMany({});
  await prisma.channelLink.deleteMany({});
  await prisma.message.deleteMany({});
  await prisma.thread.deleteMany({});
  await prisma.memoryFile.deleteMany({});
  await prisma.user.deleteMany({});
  await prisma.plan.deleteMany({});
}

beforeEach(async () => {
  viewer.current = null;
  chatCalls.length = 0;
  ocrCalls.length = 0;
  await wipe();
});
afterAll(async () => {
  await wipe();
  await prisma.$disconnect();
});

describe("sniffFile", () => {
  it("knows each supported kind from its bytes, or its name where the bytes cannot tell", () => {
    expect(sniffFile(pdf("x"), "a.bin")?.kind).toBe("pdf");
    expect(sniffFile(JPEG, "a.txt")?.kind).toBe("image");
    expect(sniffFile(DOCX_BYTES, "a.docx")?.label).toBe("Word");
    expect(sniffFile(DOCX_BYTES, "noext", XLSX)?.label).toBe("Excel");
    expect(sniffFile(enc("# Title"), "notes.md")?.label).toBe("Markdown");
    expect(sniffFile(enc('{"a":1}'), "data.json")?.label).toBe("JSON");
    expect(sniffFile(enc("a,b\n1,2"), "x", "text/csv")?.label).toBe("CSV");
    expect(sniffFile(enc("hello"), "readme.txt")?.label).toBe("Text");
  });

  it("refuses binary dressed as text, an unknown zip and an unknown type", () => {
    expect(sniffFile(Uint8Array.from([0, 1, 2, 3, 0, 0, 7]), "evil.txt")).toBeNull();
    expect(sniffFile(DOCX_BYTES, "archive.zip")).toBeNull();
    expect(sniffFile(enc("MZ......"), "setup.exe")).toBeNull();
    expect(sniffFile(new Uint8Array(), "empty.txt")).toBeNull();
  });
});

describe("extractFileText", () => {
  const noOcr = async () => null;

  it("reads a PDF's text layer without OCR", async () => {
    const ocr = vi.fn(noOcr);
    const read = await extractFileText(pdf("Quarterly revenue grew by twelve percent"), sniffFile(pdf("x"), "r.pdf")!, ocr);
    expect(read).toMatchObject({ ok: true, method: "pdf" });
    expect(read.ok && read.text).toContain("Quarterly revenue grew");
    expect(ocr).not.toHaveBeenCalled();
  });

  it("sends a PDF with no text layer, and an image, to OCR", async () => {
    const ocr = vi.fn(async () => "scanned words");
    expect(await extractFileText(pdf(""), sniffFile(pdf(""), "scan.pdf")!, ocr)).toMatchObject({ ok: true, method: "ocr", text: "scanned words" });
    expect(await extractFileText(JPEG, sniffFile(JPEG, "p.jpg")!, ocr)).toMatchObject({ ok: true, method: "ocr" });
    expect(ocr).toHaveBeenCalledTimes(2);
  });

  it("says why when nothing could be read", async () => {
    expect(await extractFileText(JPEG, sniffFile(JPEG, "p.jpg")!, noOcr)).toMatchObject({ ok: false });
    const broken = await extractFileText(enc("PK\u0003\u0004 not really"), { kind: "office", mime: DOCX, label: "Word" }, noOcr);
    expect(broken.ok).toBe(false);
  });

  it("reads Word, pretty-prints JSON and decodes text", async () => {
    const word = await extractFileText(DOCX_BYTES, sniffFile(DOCX_BYTES, "l.docx")!, noOcr);
    expect(word.ok && word.text).toContain("Lease agreement");
    const json = await extractFileText(enc('{"city":"Jeddah"}'), sniffFile(enc("{}"), "a.json")!, noOcr);
    expect(json.ok && json.text).toBe('{\n  "city": "Jeddah"\n}');
  });
});

describe("POST /api/files (platform chat)", () => {
  it("needs a signed-in user", async () => {
    expect((await upload(form(enc("hi"), "a.txt"))).status).toBe(401);
  });

  it("keeps a Word file in the sender's space with its text", async () => {
    const owner = await user("a@example.test");
    viewer.current = owner;
    const reply = await upload(form(DOCX_BYTES, "lease.docx"));
    expect(reply.status).toBe(201);
    const body = await reply.json();
    expect(body).toMatchObject({ name: "lease.docx", label: "Word", readable: true });
    expect(body.url).toBeUndefined();

    const row = await prisma.userFile.findUniqueOrThrow({ where: { id: body.id } });
    expect(row).toMatchObject({ userId: owner.id, channel: "platform", method: "office" });
    expect(row.text).toContain("rent 5000");
    expect(await prisma.userFileChunk.count({ where: { fileId: row.id, userId: owner.id } })).toBeGreaterThan(0);
  });

  it("reads an image with OCR and also stores it as media, so it can still be a post's image", async () => {
    viewer.current = await user("a@example.test");
    const body = await (await upload(form(JPEG, "invoice.jpg", "image/jpeg"))).json();
    expect(ocrCalls).toEqual(["image/jpeg"]);
    expect(body.url).toMatch(/\/api\/media\/[A-Za-z0-9_-]{43}\.jpg$/);
    expect((await prisma.userFile.findUniqueOrThrow({ where: { id: body.id } })).text).toContain("فاتورة");
  });

  it("refuses a type it cannot read, and a file over 10 MB", async () => {
    viewer.current = await user("a@example.test");
    const exe = await upload(form(enc("MZ\u0000\u0000binary"), "setup.exe"));
    expect(exe.status).toBe(400);
    expect((await exe.json()).error).toMatch(/cannot be read/);
    const big = await upload(form(new Uint8Array(10 * 1024 * 1024 + 1).fill(65), "big.txt"));
    expect(big.status).toBe(400);
    expect(await prisma.userFile.count()).toBe(0);
  });
});

describe("sending a message with a file", () => {
  it("gives the assistant the file's text, and shows the person only the file's name", async () => {
    const owner = await user("a@example.test");
    viewer.current = owner;
    const { id } = await (await upload(form(DOCX_BYTES, "lease.docx"))).json();
    const thread = await prisma.thread.create({ data: { userId: owner.id, title: "t" } });

    const data = new FormData();
    data.set("threadId", thread.id);
    data.set("message", "كم الإيجار؟");
    data.append("file", id);
    await followUp(data);

    const stored = await prisma.message.findFirstOrThrow({ where: { threadId: thread.id, role: "USER" } });
    expect(stored.body).toBe("كم الإيجار؟\n\nAttached file: lease.docx");
    expect(chatCalls).toHaveLength(1);
    expect(chatCalls[0].chatInput).toContain('[The user attached the file "lease.docx" (Word)');
    expect(chatCalls[0].chatInput).toContain("rent 5000 per month");
    expect(chatCalls[0].chatInput).toContain("ملفات المستخدم المحفوظة");
  });

  it("answers a file sent without a word", async () => {
    const owner = await user("a@example.test");
    viewer.current = owner;
    const { id } = await (await upload(form(enc("meeting at 10"), "note.txt"))).json();
    const thread = await prisma.thread.create({ data: { userId: owner.id, title: "t" } });
    const data = new FormData();
    data.set("threadId", thread.id);
    data.set("message", "");
    data.append("file", id);
    await followUp(data);
    expect(chatCalls[0].chatInput).toContain(files.ATTACHED_ONLY);
    expect(chatCalls[0].chatInput).toContain("meeting at 10");
  });

  it("ignores another person's file id", async () => {
    const owner = await user("a@example.test");
    const other = await user("b@example.test");
    viewer.current = other;
    const { id } = await (await upload(form(enc("other's secret plan"), "secret.txt"))).json();

    viewer.current = owner;
    const thread = await prisma.thread.create({ data: { userId: owner.id, title: "t" } });
    const data = new FormData();
    data.set("threadId", thread.id);
    data.set("message", "what does it say?");
    data.append("file", id);
    await followUp(data);
    expect(chatCalls[0].chatInput).not.toContain("secret");
  });
});

describe("finding a file again later", () => {
  it("puts matching passages of the person's own files in front of a later message, and nobody else's", async () => {
    const owner = await user("a@example.test");
    const other = await user("b@example.test");
    await files.saveUserFile({ userId: owner.id, fileName: "lease.docx", bytes: DOCX_BYTES, channel: "platform" });
    await files.saveUserFile({
      userId: other.id,
      fileName: "x.txt",
      bytes: enc("Riyadh office lease is 9999 per month"),
      channel: "platform",
    });

    const context = await files.filesContext(owner.id, "what is the rent of the Riyadh office lease?");
    expect(context).toContain("- lease.docx (Word,");
    expect(context).toContain("rent 5000 per month");
    expect(context).not.toContain("9999");
    expect(await files.filesContext((await user("c@example.test")).id, "rent")).toBe("");
  });

  it("embeds a file's passages for search by meaning", async () => {
    const owner = await user("a@example.test");
    const saved = await files.saveUserFile({ userId: owner.id, fileName: "a.txt", bytes: enc("alpha beta gamma"), channel: "platform" });
    if (!saved.ok) throw new Error(saved.error);
    await files.indexUserFile(saved.id);
    const [row] = await prisma.$queryRaw<{ n: bigint }[]>`
      SELECT count(*) AS n FROM "UserFileChunk" WHERE "fileId" = ${saved.id} AND embedding IS NOT NULL`;
    expect(Number(row.n)).toBeGreaterThan(0);
    expect((await prisma.userFile.findUniqueOrThrow({ where: { id: saved.id } })).embeddingModel).toBe("fake");
  });

  it("removes only the person's own file", async () => {
    const owner = await user("a@example.test");
    const other = await user("b@example.test");
    const saved = await files.saveUserFile({ userId: owner.id, fileName: "a.txt", bytes: enc("hello"), channel: "platform" });
    if (!saved.ok) throw new Error(saved.error);
    expect(await files.deleteUserFile(other.id, saved.id)).toBe(false);
    expect(await files.deleteUserFile(owner.id, saved.id)).toBe(true);
    expect(await prisma.userFileChunk.count()).toBe(0);
  });
});

describe("WhatsApp", () => {
  async function linked(number = "966500000001") {
    const owner = await user("w@example.test");
    await prisma.channelLink.create({ data: { userId: owner.id, channel: "whatsapp", externalId: number } });
    return owner;
  }

  const fileForm = (fields: Record<string, string>, bytes?: Uint8Array, name = "doc.pdf") => {
    const body = new FormData();
    for (const [k, v] of Object.entries(fields)) body.set(k, v);
    if (bytes) body.set("file", new File([Buffer.from(bytes)], name));
    return body;
  };

  it("needs the channel token", async () => {
    const reply = await whatsappFile(
      new Request("http://localhost/x", { method: "POST", body: fileForm({ whatsappUserId: "1" }, enc("a")) }),
    );
    expect(reply.status).toBe(401);
  });

  it("refuses a number that is not linked", async () => {
    const reply = await whatsappFile(
      new Request("http://localhost/x", {
        method: "POST",
        headers: channelHeaders,
        body: fileForm({ whatsappUserId: "966500000009" }, enc("a"), "a.txt"),
      }),
    );
    expect(reply.status).toBe(404);
  });

  it("keeps a document in the linked person's space and returns the note for the orchestrator", async () => {
    const owner = await linked();
    const reply = await whatsappFile(
      new Request("http://localhost/x", {
        method: "POST",
        headers: channelHeaders,
        body: fileForm(
          { whatsappUserId: "966500000001", fileName: "report.pdf", mimeType: "application/pdf" },
          pdf("Board meeting moved to Sunday"),
          "blob",
        ),
      }),
    );
    expect(reply.status).toBe(201);
    const body = await reply.json();
    expect(body).toMatchObject({ name: "report.pdf", readable: true });
    expect(body.note).toContain("Board meeting moved to Sunday");
    expect(await prisma.userFile.findFirstOrThrow({ where: { id: body.fileId } })).toMatchObject({
      userId: owner.id,
      channel: "whatsapp",
    });
  });

  it("puts the person's memory and matching file passages in front of a later WhatsApp message", async () => {
    const owner = await linked();
    await prisma.memoryFile.create({ data: { userId: owner.id, name: "Profile", content: "- اسمي سعد" } });
    await files.saveUserFile({ userId: owner.id, fileName: "lease.docx", bytes: DOCX_BYTES, channel: "whatsapp" });

    const reply = await whatsappContext(
      new Request("http://localhost/x", {
        method: "POST",
        headers: { ...channelHeaders, "content-type": "application/json" },
        body: JSON.stringify({ whatsappUserId: "966500000001", text: "how much is the office rent per month?" }),
      }),
    );
    expect(reply.status).toBe(200);
    const { chatInput } = await reply.json();
    expect(chatInput).toContain("اسمي سعد");
    expect(chatInput).toContain("rent 5000 per month");
    expect(chatInput.endsWith("how much is the office rent per month?")).toBe(true);
  });
});
