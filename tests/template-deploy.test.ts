import { afterEach, describe, expect, it, vi } from "vitest";
import { n8n } from "@/lib/n8n";
import { liveDriver } from "@/lib/n8n/live";
import { deployCopy, removeCopy, type DeployInput } from "@/server/template-deploy";

/**
 * Installing a copy on the platform. The n8n calls are spied on so each case can say
 * which ones happened, in what order, and what was cleaned up after a refusal.
 */

const TEMPLATE = {
  nodes: [
    { name: "Trigger", type: "n8n-nodes-base.executeWorkflowTrigger", parameters: {} },
    {
      name: "Gemini",
      type: "@n8n/n8n-nodes-langchain.lmChatGoogleGemini",
      parameters: {},
      credentials: { googlePalmApi: { id: "tpl", name: "tpl" } },
    },
  ],
  connections: {},
};

function input(overrides: Partial<DeployInput> = {}): DeployInput {
  return {
    userId: "u1",
    templateId: "tpl_1",
    n8nWorkflowId: "wf_template",
    requiredCredentials: ["googlePalmApi"],
    schedule: "",
    supplied: { googlePalmApi: { apiKey: "k" } },
    knowledgeKey: "",
    platformUrl: "https://app.example.test",
    ...overrides,
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("deployCopy", () => {
  it("creates the credential, writes the copy, switches it on, and returns the ids", async () => {
    vi.spyOn(n8n, "getWorkflow").mockResolvedValue(TEMPLATE);
    const createCredential = vi.spyOn(n8n, "createCredential").mockResolvedValue({ id: "c1" });
    const createWorkflow = vi.spyOn(n8n, "createWorkflow").mockResolvedValue({ id: "wf_copy" });
    const activate = vi.spyOn(n8n, "activateWorkflow").mockResolvedValue({ ok: true });

    const result = await deployCopy(input());

    expect(createCredential).toHaveBeenCalledWith({
      name: "u_u1_tpl_1_googlePalmApi",
      type: "googlePalmApi",
      data: { apiKey: "k" },
    });
    const copy = createWorkflow.mock.calls[0][0] as { name: string; nodes: Array<{ credentials?: unknown }> };
    expect(copy.name).toBe("u_u1_tpl_1");
    expect(copy.nodes[1].credentials).toEqual({ googlePalmApi: { id: "c1", name: "u_u1_tpl_1_googlePalmApi" } });
    expect(activate).toHaveBeenCalledWith("wf_copy");
    expect(result).toMatchObject({
      ok: true,
      instanceWorkflowId: "wf_copy",
      n8nCredentialIds: ["c1"],
      activationStatus: "active",
    });
  });

  it("refuses an install with a credential missing, and creates nothing", async () => {
    vi.spyOn(n8n, "getWorkflow").mockResolvedValue(TEMPLATE);
    const createCredential = vi.spyOn(n8n, "createCredential");

    const result = await deployCopy(input({ supplied: {} }));

    expect(result).toEqual({
      ok: false,
      missingCredentials: "googlePalmApi",
      errorText: "لم يتم التفعيل. ناقص: googlePalmApi",
    });
    expect(createCredential).not.toHaveBeenCalled();
  });

  it("refuses when the template cannot be read", async () => {
    vi.spyOn(n8n, "getWorkflow").mockResolvedValue(null);
    const createWorkflow = vi.spyOn(n8n, "createWorkflow");

    const result = await deployCopy(input());

    expect(result.ok).toBe(false);
    expect(createWorkflow).not.toHaveBeenCalled();
  });

  it("deletes the credentials it created when n8n refuses the copy", async () => {
    vi.spyOn(n8n, "getWorkflow").mockResolvedValue(TEMPLATE);
    vi.spyOn(n8n, "createCredential").mockResolvedValue({ id: "c1" });
    vi.spyOn(n8n, "createWorkflow").mockResolvedValue(null);
    const deleteCredential = vi.spyOn(n8n, "deleteCredential").mockResolvedValue({ ok: true });
    const activate = vi.spyOn(n8n, "activateWorkflow");
    vi.spyOn(console, "error").mockImplementation(() => {});

    const result = await deployCopy(input());

    expect(result.ok).toBe(false);
    expect(deleteCredential).toHaveBeenCalledWith("c1");
    expect(activate).not.toHaveBeenCalled();
  });

  it("has nothing to clean up when the first credential is refused", async () => {
    vi.spyOn(n8n, "getWorkflow").mockResolvedValue(TEMPLATE);
    vi.spyOn(n8n, "createCredential").mockResolvedValue(null);
    const deleteCredential = vi.spyOn(n8n, "deleteCredential");
    vi.spyOn(console, "error").mockImplementation(() => {});

    const result = await deployCopy(input());

    expect(result.ok).toBe(false);
    expect(deleteCredential).not.toHaveBeenCalled();
  });

  it("keeps the copy when it is written but will not switch on, and says so", async () => {
    vi.spyOn(n8n, "getWorkflow").mockResolvedValue(TEMPLATE);
    vi.spyOn(n8n, "createCredential").mockResolvedValue({ id: "c1" });
    vi.spyOn(n8n, "createWorkflow").mockResolvedValue({ id: "wf_copy" });
    vi.spyOn(n8n, "activateWorkflow").mockResolvedValue({ ok: false });
    const deleteCredential = vi.spyOn(n8n, "deleteCredential");

    const result = await deployCopy(input());

    expect(result).toMatchObject({ ok: true, instanceWorkflowId: "wf_copy", activationStatus: "activation_failed" });
    expect(deleteCredential).not.toHaveBeenCalled();
  });

  it("creates the knowledge credential and binds it when the template searches the person's files", async () => {
    const withKnowledge = {
      nodes: [
        {
          name: "Search",
          type: "n8n-nodes-base.httpRequest",
          parameters: {
            headerParameters: { parameters: [{ name: "Authorization", value: "Bearer __MP_KNOWLEDGE_KEY__" }] },
          },
        },
      ],
      connections: {},
    };
    vi.spyOn(n8n, "getWorkflow").mockResolvedValue(withKnowledge);
    const createCredential = vi
      .spyOn(n8n, "createCredential")
      .mockResolvedValue({ id: "kc" });
    const createWorkflow = vi.spyOn(n8n, "createWorkflow").mockResolvedValue({ id: "wf_copy" });
    vi.spyOn(n8n, "activateWorkflow").mockResolvedValue({ ok: true });

    const result = await deployCopy(input({ requiredCredentials: [], supplied: {}, knowledgeKey: "kb_1" }));

    expect(createCredential).toHaveBeenCalledWith({
      name: "u_u1_tpl_1_knowledge",
      type: "httpHeaderAuth",
      data: { name: "Authorization", value: "Bearer kb_1" },
    });
    const copy = createWorkflow.mock.calls[0][0] as { nodes: Array<{ credentials?: unknown }> };
    expect(copy.nodes[0].credentials).toEqual({ httpHeaderAuth: { id: "kc", name: "u_u1_tpl_1_knowledge" } });
    expect(result.ok).toBe(true);
  });
});

describe("the live copy calls", () => {
  function stubFetch(response: Response) {
    const fetchImpl = vi.fn(async () => response);
    vi.stubGlobal("fetch", fetchImpl);
    return fetchImpl;
  }

  it("creates a credential with the public API and returns its id", async () => {
    const fetchImpl = stubFetch(new Response(JSON.stringify({ id: "c9" }), { status: 200 }));
    try {
      expect(await liveDriver.createCredential({ name: "n", type: "t", data: { a: 1 } })).toEqual({ id: "c9" });
      const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
      expect(url.endsWith("/credentials")).toBe(true);
      expect(init.method).toBe("POST");
      expect(JSON.parse(init.body as string)).toEqual({ name: "n", type: "t", data: { a: 1 } });
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("returns null for a credential n8n refuses", async () => {
    stubFetch(new Response("{}", { status: 400 }));
    try {
      expect(await liveDriver.createCredential({ name: "n", type: "t", data: {} })).toBeNull();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("deletes a workflow and a credential by id", async () => {
    const fetchImpl = stubFetch(new Response("{}", { status: 200 }));
    try {
      expect(await liveDriver.deleteWorkflow("wf 2")).toEqual({ ok: true });
      const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
      expect(url.endsWith("/workflows/wf%202")).toBe(true);
      expect(init.method).toBe("DELETE");
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("reads a template's nodes and connections", async () => {
    stubFetch(new Response(JSON.stringify({ nodes: [{ name: "a" }], connections: { a: {} } }), { status: 200 }));
    try {
      expect(await liveDriver.getWorkflow("wf_t")).toEqual({ nodes: [{ name: "a" }], connections: { a: {} } });
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

describe("removeCopy", () => {
  it("deletes the workflow, then each credential it was bound to", async () => {
    const deleteWorkflow = vi.spyOn(n8n, "deleteWorkflow").mockResolvedValue({ ok: true });
    const deleteCredential = vi.spyOn(n8n, "deleteCredential").mockResolvedValue({ ok: true });

    const result = await removeCopy({ instanceWorkflowId: "wf_copy", n8nCredentialIds: ["c1", "kc"] });

    expect(deleteWorkflow).toHaveBeenCalledWith("wf_copy");
    expect(deleteCredential.mock.calls.map((c) => c[0])).toEqual(["c1", "kc"]);
    expect(result).toEqual({ workflowRemoved: true, credentialsRemoved: 2 });
  });

  it("keeps going when n8n refuses a delete, and reports it", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(n8n, "deleteWorkflow").mockResolvedValue({ ok: false });
    vi.spyOn(n8n, "deleteCredential").mockResolvedValueOnce({ ok: false }).mockResolvedValueOnce({ ok: true });

    const result = await removeCopy({ instanceWorkflowId: "wf_copy", n8nCredentialIds: ["c1", "c2"] });

    expect(result).toEqual({ workflowRemoved: false, credentialsRemoved: 1 });
  });

  it("removes only the workflow for a copy with no recorded credentials", async () => {
    const deleteCredential = vi.spyOn(n8n, "deleteCredential");
    vi.spyOn(n8n, "deleteWorkflow").mockResolvedValue({ ok: true });

    await removeCopy({ instanceWorkflowId: "wf_copy", n8nCredentialIds: [] });

    expect(deleteCredential).not.toHaveBeenCalled();
  });
});
