import { describe, expect, it } from "vitest";
import { validateUpload, type CredentialRule, type NodeVerdict, type UploadInput } from "@/server/template-upload";

/**
 * The upload checks, with the whitelist and credential rules given directly. Each
 * case is one rule of the n8n Upload & Provision workflow.
 */

const WEBHOOK = "n8n-nodes-base.webhook";
const EWT = "n8n-nodes-base.executeWorkflowTrigger";

const NODE_RULES: Record<string, NodeVerdict> = {
  "n8n-nodes-base.set": "allow",
  "n8n-nodes-base.code": "review",
  "n8n-nodes-base.executeCommand": "deny",
  "@n8n/n8n-nodes-langchain.lmChatGoogleGemini": "allow",
  "n8n-nodes-base.googleDrive": "allow",
  "n8n-nodes-base.respondToWebhook": "allow",
  [WEBHOOK]: "allow",
  "@n8n/n8n-nodes-langchain.chatTrigger": "allow",
  "n8n-nodes-base.scheduleTrigger": "allow",
  [EWT]: "allow",
  "n8n-nodes-base.noOp": "allow",
  "n8n-nodes-base.httpRequest": "allow",
};

const CREDENTIAL_RULES: Record<string, CredentialRule> = {
  googlePalmApi: { durability: "durable", registered: true, authFlow: "", flowReady: true, note: "" },
  googleSheetsOAuth2Api: { durability: "oauth", registered: false, authFlow: "oauth", flowReady: false, note: "" },
};

function input(file: unknown, overrides: Partial<UploadInput> = {}): UploadInput {
  return {
    file,
    title: "Digest",
    description: "d",
    actionType: "read",
    creatorId: "creator_1",
    templateId: "tpl_test",
    nodeRules: NODE_RULES,
    credRules: CREDENTIAL_RULES,
    storageWorkflowId: "wf_storage",
    ...overrides,
  };
}

const webhookWorkflow = {
  nodes: [
    { name: "Hook", type: WEBHOOK, parameters: { path: "digest" }, webhookId: "abc" },
    {
      name: "Build",
      type: "n8n-nodes-base.set",
      parameters: { value: '={{ $("Hook").item.json.body.topic }} and {{ $json.body.limit }}' },
    },
  ],
  connections: { Hook: { main: [[{ node: "Build", type: "main", index: 0 }]] } },
};

describe("validateUpload — the file", () => {
  it("refuses something that is not a workflow", () => {
    const verdict = validateUpload(input("not json"));
    expect(verdict.ok).toBe(false);
    expect(verdict.errors).toContain("الملف ليس JSON صالحاً");
  });

  it("refuses a workflow with no trigger", () => {
    const verdict = validateUpload(input({ nodes: [{ name: "S", type: "n8n-nodes-base.set", parameters: {} }], connections: {} }));
    expect(verdict.errors).toContain("القالب لا يحتوي على مشغّل");
  });

  it("refuses two on-demand triggers", () => {
    const verdict = validateUpload(
      input({
        nodes: [
          { name: "A", type: WEBHOOK, parameters: {} },
          { name: "B", type: "@n8n/n8n-nodes-langchain.chatTrigger", parameters: {} },
        ],
        connections: {},
      }),
    );
    expect(verdict.errors.some((e) => e.startsWith("القالب يحتوي أكثر من مشغّل استدعاء واحد"))).toBe(true);
  });

  it("refuses a node the whitelist denies, and names it", () => {
    const verdict = validateUpload(
      input({
        nodes: [
          { name: "Hook", type: WEBHOOK, parameters: {} },
          { name: "Shell", type: "n8n-nodes-base.executeCommand", parameters: {} },
        ],
        connections: {},
      }),
    );
    expect(verdict.ok).toBe(false);
    expect(verdict.errors).toContain("عقدة ممنوعة: n8n-nodes-base.executeCommand");
  });

  it("accepts a reviewed node and records it for review", () => {
    const verdict = validateUpload(input({ ...webhookWorkflow, nodes: [...webhookWorkflow.nodes, { name: "Code", type: "n8n-nodes-base.code", parameters: { jsCode: "return items;" } }] }));
    expect(verdict.ok).toBe(true);
    expect(verdict.flaggedNodes).toContain("n8n-nodes-base.code");
  });
});

describe("validateUpload — inputs", () => {
  it("reads the fields a webhook trigger's body is used for, and rewires the trigger", () => {
    const verdict = validateUpload(input(webhookWorkflow));

    expect(verdict.ok).toBe(true);
    expect(verdict.inputSchema.map((f) => f.name)).toEqual(["topic", "limit"]);
    expect(verdict.invocationMode).toBe("on_demand");
    const trigger = verdict.workflowObject.nodes.find((n) => n.name === "Hook")!;
    expect(trigger.type).toBe(EWT);
    expect(trigger.parameters).toMatchObject({
      inputSource: "workflowInputs",
      workflowInputs: { values: [{ name: "topic", type: "string" }, { name: "limit", type: "string" }] },
    });
    expect(verdict.notes.some((n) => n.startsWith("استُبدل المشغّل Hook"))).toBe(true);
  });

  it("removes the body prefix from the references so they read the flat field", () => {
    const verdict = validateUpload(input(webhookWorkflow));
    const build = verdict.workflowObject.nodes.find((n) => n.name === "Build")!;
    expect(JSON.stringify(build.parameters)).toContain('$(\\"Hook\\").item.json.topic');
    expect(JSON.stringify(build.parameters)).not.toContain(".body.topic");
  });

  it("asks the field list of a chat trigger, with the session filled by the platform", () => {
    const verdict = validateUpload(
      input({
        nodes: [
          { name: "Chat", type: "@n8n/n8n-nodes-langchain.chatTrigger", parameters: {} },
          { name: "Reply", type: "n8n-nodes-base.noOp", parameters: {} },
        ],
        connections: { Chat: { main: [[{ node: "Reply", type: "main", index: 0 }]] } },
      }),
    );
    expect(verdict.inputSchema).toEqual([
      { name: "chatInput", type: "string", required: true },
      { name: "sessionId", type: "string", system: true },
    ]);
  });

  it("marks a template that also runs on a schedule as on_demand and scheduled together", () => {
    const verdict = validateUpload(
      input({
        nodes: [
          { name: "Hook", type: WEBHOOK, parameters: {} },
          { name: "Daily", type: "n8n-nodes-base.scheduleTrigger", parameters: {} },
        ],
        connections: {},
      }),
    );
    expect(verdict.invocationMode).toBe("on_demand,scheduled");
  });

  it("asks for confirmation when a reference cannot be read with confidence", () => {
    const verdict = validateUpload(
      input({
        nodes: [
          { name: "Hook", type: WEBHOOK, parameters: {} },
          { name: "Build", type: "n8n-nodes-base.set", parameters: { value: "={{ Object.keys($json) }}" } },
        ],
        connections: { Hook: { main: [[{ node: "Build", type: "main", index: 0 }]] } },
      }),
    );
    expect(verdict.inferenceStatus).toBe("needs_confirmation");
  });
});

describe("validateUpload — credentials", () => {
  it("removes credentials from the nodes and keeps which node used which", () => {
    const verdict = validateUpload(
      input({
        nodes: [
          { name: "Hook", type: WEBHOOK, parameters: {} },
          {
            name: "Gemini",
            type: "@n8n/n8n-nodes-langchain.lmChatGoogleGemini",
            parameters: {},
            credentials: { googlePalmApi: { id: "tpl", name: "tpl" } },
          },
        ],
        connections: {},
      }),
    );

    expect(verdict.credentialNodeMap).toEqual({ Gemini: ["googlePalmApi"] });
    expect(verdict.requiredCredentials).toEqual(["googlePalmApi"]);
    expect(verdict.credentialDurability).toBe("durable");
    expect(verdict.workflowObject.nodes.find((n) => n.name === "Gemini")!.credentials).toBeUndefined();
  });

  it("blocks a template whose credential has no rule in the platform", () => {
    const verdict = validateUpload(
      input({
        nodes: [
          { name: "Hook", type: WEBHOOK, parameters: {} },
          { name: "Other", type: "n8n-nodes-base.httpRequest", parameters: {}, credentials: { mysteryApi: {} } },
        ],
        connections: {},
      }),
    );
    expect(verdict.credentialDurability).toBe("blocked");
    expect(verdict.blockedCredentials).toEqual(["mysteryApi"]);
  });

  it("blocks an OAuth connection whose app is not registered, and admits one that is ready", () => {
    const withCredential = (type: string) =>
      validateUpload(
        input({
          nodes: [
            { name: "Hook", type: WEBHOOK, parameters: {} },
            { name: "Sheet", type: "n8n-nodes-base.httpRequest", parameters: {}, credentials: { [type]: {} } },
          ],
          connections: {},
        }),
      );

    expect(withCredential("googleSheetsOAuth2Api").credentialDurability).toBe("blocked");
    expect(withCredential("googlePalmApi").credentialDurability).toBe("durable");
  });
});

describe("validateUpload — the stored copy", () => {
  it("turns each responder into a pass-through and says so", () => {
    const verdict = validateUpload(
      input({
        nodes: [
          { name: "Hook", type: WEBHOOK, parameters: {} },
          { name: "Answer", type: "n8n-nodes-base.respondToWebhook", parameters: { respondWith: "text" } },
        ],
        connections: {},
      }),
    );
    const answer = verdict.workflowObject.nodes.find((n) => n.name === "Answer")!;
    expect(answer.type).toBe("n8n-nodes-base.noOp");
    expect(verdict.notes).toContain("حُوّلت عقدة الرد Answer إلى عقدة تمرير");
  });

  it("moves a Drive upload onto the storage workflow, with an encode step before it", () => {
    const verdict = validateUpload(
      input({
        nodes: [
          { name: "Hook", type: WEBHOOK, parameters: {} },
          {
            name: "Save",
            type: "n8n-nodes-base.googleDrive",
            parameters: { resource: "file", operation: "upload", name: "report.txt" },
          },
        ],
        connections: { Hook: { main: [[{ node: "Save", type: "main", index: 0 }]] } },
      }),
    );

    const save = verdict.workflowObject.nodes.find((n) => n.name === "Save")!;
    expect(save.type).toBe("n8n-nodes-base.executeWorkflow");
    expect(save.parameters).toMatchObject({
      workflowId: { value: "wf_storage" },
      workflowInputs: { value: { installationId: "__MP_INSTALLATION_ID__", operation: "put" } },
    });
    expect(verdict.workflowObject.nodes.some((n) => n.name === "Save (encode)")).toBe(true);
    expect(verdict.flaggedNodes).toContain("storage:put");
  });

  it("writes the code of every generated step so it parses", () => {
    const verdict = validateUpload(
      input({
        nodes: [
          { name: "Hook", type: WEBHOOK, parameters: {} },
          { name: "Save", type: "n8n-nodes-base.googleDrive", parameters: { resource: "file", operation: "upload", name: "r.txt" } },
          { name: "Read", type: "n8n-nodes-base.googleDrive", parameters: { resource: "file", operation: "download", fileId: "x" } },
        ],
        connections: {},
      }),
    );
    for (const node of verdict.workflowObject.nodes) {
      const code = (node.parameters as { jsCode?: string } | undefined)?.jsCode;
      if (code !== undefined) {
        expect(() => new Function(`return (async function () {\n${code}\n});`)).not.toThrow();
      }
    }
  });

  it("flags a host on the local network, and a placeholder secret", () => {
    const verdict = validateUpload(
      input({
        nodes: [
          { name: "Hook", type: WEBHOOK, parameters: {} },
          { name: "Call", type: "n8n-nodes-base.httpRequest", parameters: { url: "http://192.168.1.5/api" } },
          { name: "Key", type: "n8n-nodes-base.set", parameters: { apiKey: "YOUR_API_KEY" } },
        ],
        connections: {},
      }),
    );
    expect(verdict.flaggedNodes).toContain("host:internal");
    expect(verdict.flaggedNodes).toContain("placeholder-secret");
    expect(verdict.inferenceStatus).toBe("needs_confirmation");
    expect(verdict.externalHosts).toContain("192.168.1.5");
  });

  it("gives an unchanged file the same hash, and a changed one a different hash", () => {
    const a = validateUpload(input(webhookWorkflow));
    const b = validateUpload(input(webhookWorkflow));
    const changed = validateUpload(input({ ...webhookWorkflow, nodes: [...webhookWorkflow.nodes, { name: "X", type: "n8n-nodes-base.set", parameters: {} }] }));

    expect(a.contentHash).toBe(b.contentHash);
    expect(changed.contentHash).not.toBe(a.contentHash);
  });
});
