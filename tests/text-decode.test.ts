import { describe, expect, it } from "vitest";
import { decodeText } from "@/lib/text-decode";
import { looksUnreadable } from "@/lib/text-quality";

const bytes = (...parts: (number[] | string)[]) =>
  new Uint8Array(parts.flatMap((p) => (typeof p === "string" ? [...Buffer.from(p, "utf8")] : p)));

describe("decodeText", () => {
  it("reads UTF-8, with or without a BOM", () => {
    expect(decodeText(bytes("name,city\nأحمد,الرياض"))).toBe("name,city\nأحمد,الرياض");
    expect(decodeText(bytes([0xef, 0xbb, 0xbf], "a,b"))).toBe("a,b");
  });

  it("reads UTF-16 by its BOM (Excel's 'Unicode Text')", () => {
    const le = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from("اسم,مدينة", "utf16le")]);
    expect(decodeText(new Uint8Array(le))).toBe("اسم,مدينة");
    const be = Buffer.from(Buffer.from("اسم,مدينة", "utf16le")).swap16();
    expect(decodeText(new Uint8Array(Buffer.concat([Buffer.from([0xfe, 0xff]), be])))).toBe("اسم,مدينة");
  });

  it("reads Arabic Windows-1256, which is what Excel on an Arabic Windows saves as CSV", () => {
    // "Name,Riyadh" with the Arabic word "الرياض" encoded as Windows-1256 bytes.
    const cp1256 = [0xc7, 0xe1, 0xd1, 0xed, 0xc7, 0xd6];
    const text = decodeText(bytes("Name,", cp1256, "\n"));
    expect(text).toBe("Name,الرياض\n");
    expect(text).not.toContain("�");
  });

  it("reads other single-byte text as Windows-1252", () => {
    expect(decodeText(bytes("caf", [0xe9], " cr", [0xe8], "me"))).toBe("café crème");
  });

  it("means a Windows-1256 CSV is no longer judged unreadable", () => {
    const line = [...Buffer.from("Ahmed,"), 0xc7, 0xe1, 0xd1, 0xed, 0xc7, 0xd6, ...Buffer.from(",555\n")];
    const csv = new Uint8Array([...Buffer.from("Name,City,Phone\n"), ...Array.from({ length: 150 }, () => line).flat()]);
    // Read as UTF-8, as it used to be, it is a run of replacement characters...
    expect(looksUnreadable(new TextDecoder("utf-8").decode(csv))).toBe(true);
    // ...decoded by its own encoding, it is an ordinary CSV.
    const text = decodeText(csv);
    expect(looksUnreadable(text)).toBe(false);
    expect(text).toContain("Ahmed,الرياض,555");
  });
});
