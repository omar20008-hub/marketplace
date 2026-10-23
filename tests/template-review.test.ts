import { afterEach, describe, expect, it, vi } from "vitest";
import { n8n } from "@/lib/n8n";
import { publishTemplateWorkflow } from "@/server/template-review";

/** Approving a template on the platform: what is refused, and what is switched on. */

afterEach(() => {
  vi.restoreAllMocks();
});

describe("publishTemplateWorkflow", () => {
  it("refuses a template whose credentials cannot be kept, and switches nothing on", async () => {
    const activate = vi.spyOn(n8n, "activateWorkflow");

    const result = await publishTemplateWorkflow({ n8nWorkflowId: "wf_t", credentialDurability: "blocked" });

    expect(result).toEqual({ ok: false, error: "يحتاج حسابات غير مستدامة ولا يمكن نشره" });
    expect(activate).not.toHaveBeenCalled();
  });

  it("refuses a template with no workflow in n8n", async () => {
    const activate = vi.spyOn(n8n, "activateWorkflow");

    const result = await publishTemplateWorkflow({ n8nWorkflowId: null, credentialDurability: "durable" });

    expect(result).toEqual({ ok: false, error: "القالب غير موجود" });
    expect(activate).not.toHaveBeenCalled();
  });

  it("switches the template's workflow on in n8n", async () => {
    const activate = vi.spyOn(n8n, "activateWorkflow").mockResolvedValue({ ok: true });

    const result = await publishTemplateWorkflow({ n8nWorkflowId: "wf_t", credentialDurability: "durable" });

    expect(activate).toHaveBeenCalledWith("wf_t");
    expect(result).toEqual({ ok: true });
  });

  it("still approves when n8n will not switch it on, and logs the refusal", async () => {
    vi.spyOn(n8n, "activateWorkflow").mockResolvedValue({ ok: false });
    const log = vi.spyOn(console, "error").mockImplementation(() => {});

    const result = await publishTemplateWorkflow({ n8nWorkflowId: "wf_t", credentialDurability: "durable" });

    expect(result).toEqual({ ok: true });
    expect(log).toHaveBeenCalled();
  });
});
