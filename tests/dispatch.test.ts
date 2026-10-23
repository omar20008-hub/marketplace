import { afterEach, describe, expect, it, vi } from "vitest";
import { n8n } from "@/lib/n8n";
import { liveDriver } from "@/lib/n8n/live";
import { dispatchInstance, wrapOutput, type DispatchRequest } from "@/server/dispatch";
import { env } from "@/lib/env";

/**
 * The platform's dispatch checks, in the order the MP · Dispatcher ran them. The
 * copy itself is spied on, so each case is about what the platform decides before
 * and after it runs.
 */

const FIELDS = [
  { name: "sessionId", label: "Session", type: "string", system: true },
  { name: "chatInput", label: "Question", type: "string" },
];

function request(overrides: Partial<DispatchRequest> = {}): DispatchRequest {
  return {
    userId: "user_1",
    installationId: "inst_1",
    instanceWorkflowId: "wf_copy",
    invocationMode: "on_demand",
    title: "Weekly Digest",
    inputSchema: FIELDS,
    args: { chatInput: "هذا الأسبوع" },
    ...overrides,
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("dispatchInstance — refusals before the copy runs", () => {
  it("refuses an installation with no copy in n8n", async () => {
    const run = vi.spyOn(n8n, "runInstance");

    const reply = await dispatchInstance(request({ instanceWorkflowId: null }));

    expect(reply).toEqual({
      result: "denied",
      reason: "لا يوجد تفعيل مطابق لهذا المستخدم، أو أن التفعيل موقوف",
    });
    expect(run).not.toHaveBeenCalled();
  });

  it("refuses a product that runs on a schedule rather than when asked", async () => {
    const run = vi.spyOn(n8n, "runInstance");

    const reply = await dispatchInstance(request({ invocationMode: "scheduled" }));

    expect(reply.result).toBe("denied");
    expect(run).not.toHaveBeenCalled();
  });

  it("asks for each missing input by name, and does not run the copy", async () => {
    const run = vi.spyOn(n8n, "runInstance");

    const reply = await dispatchInstance(request({ args: {} }));

    expect(reply).toMatchObject({ result: "incomplete", missing: "chatInput" });
    expect(run).not.toHaveBeenCalled();
  });

  it("does not ask for a system input the platform fills itself", async () => {
    const run = vi.spyOn(n8n, "runInstance").mockResolvedValue({ ok: true, items: [{ done: true }] });

    const reply = await dispatchInstance(request());

    expect(reply.result).toBe("success");
    expect(run).toHaveBeenCalledWith(
      "wf_copy",
      expect.objectContaining({ chatInput: "هذا الأسبوع", sessionId: "user_1:inst_1" }),
    );
  });
});

describe("dispatchInstance — running the copy", () => {
  it("returns the copy's items as the tool output", async () => {
    vi.spyOn(n8n, "runInstance").mockResolvedValue({ ok: true, items: [{ headline: "خبر" }] });

    const reply = await dispatchInstance(request());

    expect(reply).toEqual({ result: "success", toolOutput: JSON.stringify([{ headline: "خبر" }]) });
  });

  it("reports a failed run as an error with its type", async () => {
    vi.spyOn(n8n, "runInstance").mockResolvedValue({ ok: false, error: "n8n answered 500" });
    vi.spyOn(console, "error").mockImplementation(() => {});

    const reply = await dispatchInstance(request());

    expect(reply).toEqual({ result: "error", errorType: "n8n answered 500" });
  });
});

describe("wrapOutput", () => {
  it("keeps the first three items", () => {
    const items = [{ n: 1 }, { n: 2 }, { n: 3 }, { n: 4 }];
    expect(JSON.parse(wrapOutput(items))).toEqual([{ n: 1 }, { n: 2 }, { n: 3 }]);
  });

  it("cuts a long output to 4000 characters and says so", () => {
    const out = wrapOutput([{ text: "س".repeat(5000) }]);
    expect(out.endsWith("...[truncated]")).toBe(true);
    expect(out.length).toBe(4000 + "...[truncated]".length);
  });
});

describe("the live run endpoint", () => {
  it("posts the inputs to the copy's run endpoint and returns its items", async () => {
    const fetchImpl = vi.fn(
      async () => new Response(JSON.stringify([{ json: { headline: "خبر" } }]), { status: 200 }),
    );
    vi.stubGlobal("fetch", fetchImpl);
    try {
      const result = await liveDriver.runInstance("wf 1", { chatInput: "س" });

      expect(result).toEqual({ ok: true, items: [{ headline: "خبر" }] });
      const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
      expect(url.endsWith("/workflows/wf%201/run")).toBe(true);
      expect(init.method).toBe("POST");
      expect(JSON.parse(init.body as string)).toEqual({ inputData: { chatInput: "س" } });
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("reports a refused run as an error, not an exception", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("{}", { status: 500 })));
    try {
      expect(await liveDriver.runInstance("wf", {})).toEqual({ ok: false, error: "n8n answered 500" });
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("reports a run that n8n answered with an error body as a failure", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ error: "node failed" }), { status: 200 })));
    try {
      expect(await liveDriver.runInstance("wf", {})).toEqual({ ok: false, error: "node failed" });
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

describe("the dispatcher flag", () => {
  it("keeps the n8n Dispatcher unless the platform is chosen", () => {
    expect(env.dispatcher.driver).toBe("n8n");
  });
});
