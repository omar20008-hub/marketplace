import { describe, expect, it } from "vitest";
import { parseReplySources } from "@/lib/reply-sources";

describe("parseReplySources", () => {
  it("reads one web source with a markdown label", () => {
    const r = parseReplySources("Answer.\n\nSources:\n- [Example News](https://www.example.com/a/b?x=1)\n");
    expect(r.text).toBe("Answer.");
    expect(r.sources).toEqual([
      { kind: "web", name: "Example News", url: "https://www.example.com/a/b?x=1", iconUrl: "https://www.example.com/favicon.ico" },
    ]);
    expect(r.generalKnowledge).toBe(false);
  });

  it("uses the hostname without www for a bare URL, and when the label is a URL", () => {
    const r = parseReplySources("Hi\n\n**Sources:**\n* https://www.site.org/page\n* [https://other.net/x](https://other.net/x)");
    expect(r.sources.map((s) => s.name)).toEqual(["site.org", "other.net"]);
  });

  it("removes duplicate URLs, keeping the first", () => {
    const r = parseReplySources("T\n\nSources:\n1. [A](https://a.com/x)\n2. [B](https://a.com/x)\n3. https://b.com");
    expect(r.sources.map((s) => s.name)).toEqual(["A", "b.com"]);
  });

  it("understands the Arabic heading and general-knowledge line", () => {
    const r = parseReplySources("جواب\n\nالمصادر:\n- [موقع](https://example.com)\n\nمعرفة عامة دون بحث");
    expect(r.text).toBe("جواب");
    expect(r.sources).toHaveLength(1);
    expect(r.generalKnowledge).toBe(true);
  });

  it("strips a lone general-knowledge line", () => {
    const r = parseReplySources("Paris is the capital.\n\n*(General knowledge, no search)*");
    expect(r).toEqual({ text: "Paris is the capital.", sources: [], generalKnowledge: true });
    const h = parseReplySources("Paris.\n\nSources:\nGeneral knowledge without search");
    expect(h).toEqual({ text: "Paris.", sources: [], generalKnowledge: true });
  });

  it("strips the general-knowledge line when real sources exist", () => {
    const r = parseReplySources("T\n\nSources:\n- https://a.com\n- General knowledge (no search)");
    expect(r.text).toBe("T");
    expect(r.sources).toHaveLength(1);
    expect(r.generalKnowledge).toBe(true);
  });

  it("leaves a body without a block unchanged", () => {
    const body = "Some text.  \n\n";
    expect(parseReplySources(body)).toEqual({ text: body, sources: [], generalKnowledge: false });
  });

  it("does not treat prose mentions as a block", () => {
    const body = "See my sources: https://a.com\n- one\n- two\nAll sources agree.";
    expect(parseReplySources(body).sources).toEqual([]);
    expect(parseReplySources(body).text).toBe(body);
  });

  it("drops javascript: and data: items", () => {
    const r = parseReplySources("T\n\nSources:\n- [x](javascript:alert(1))\n- data:text/html,hi\n- [y](https://ok.com)");
    expect(r.sources.map((s) => s.kind)).toEqual(["web"]);
  });

  it("gives files and agents no link", () => {
    const r = parseReplySources("T\n\nSources:\n- File: report.pdf\n- Agent: Researcher\n- ملف: خطة.docx\n- Notes");
    expect(r.sources).toEqual([
      { kind: "file", name: "report.pdf" },
      { kind: "agent", name: "Researcher" },
      { kind: "file", name: "خطة.docx" },
      { kind: "other", name: "Notes" },
    ]);
  });

  it("trims the text and derives the icon from the origin", () => {
    const r = parseReplySources("Body\n\n\n## Source:\n- https://sub.example.com:8443/p\n\n\n");
    expect(r.text).toBe("Body");
    expect(r.sources[0]).toMatchObject({ iconUrl: "https://sub.example.com:8443/favicon.ico" });
  });
});
