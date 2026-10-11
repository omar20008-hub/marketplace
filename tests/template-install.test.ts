import { describe, expect, it } from "vitest";
import { buildInstanceWorkflow, planCredentials } from "@/server/template-install";

/**
 * The install transformation, with no n8n calls. Each case is one rule of the
 * n8n Install Template workflow: which credentials are still missing, and what
 * the copy looks like once it is written for one installation.
 */

const SECRET_RULES = {};

describe("planCredentials", () => {
  it("plans each credential the person supplied, named for their copy", () => {
    const plan = planCredentials({
      userId: "u1",
      templateId: "tpl_1",
      requiredCredentials: "geminiApi",
      rules: SECRET_RULES,
      supplied: { geminiApi: { apiKey: "k" } },
      usesKnowledgeKey: false,
      knowledgeKey: null,
    });

    expect(plan).toEqual({
      ready: true,
      plans: [
        {
          credentialType: "geminiApi",
          credentialName: "u_u1_tpl_1_geminiApi",
          credentialData: JSON.stringify({ apiKey: "k" }),
          role: "template",
        },
      ],
    });
  });

  it("reports a credential that was not supplied as missing", () => {
    const plan = planCredentials({
      userId: "u1",
      templateId: "tpl_1",
      requiredCredentials: "geminiApi, telegramApi",
      rules: SECRET_RULES,
      supplied: { geminiApi: { apiKey: "k" } },
      usesKnowledgeKey: false,
      knowledgeKey: null,
    });

    expect(plan).toEqual({ ready: false, missing: ["telegramApi"], needsConsent: [] });
  });

  it("refuses an OAuth connection, which the platform cannot complete yet", () => {
    const plan = planCredentials({
      userId: "u1",
      templateId: "tpl_1",
      requiredCredentials: "googleSheetsOAuth2Api",
      rules: SECRET_RULES,
      supplied: {},
      usesKnowledgeKey: false,
      knowledgeKey: null,
    });

    expect(plan).toEqual({
      ready: false,
      missing: ["googleSheetsOAuth2Api"],
      needsConsent: ["googleSheetsOAuth2Api"],
    });
  });

  it("trusts a rule that names the flow over the credential's name", () => {
    const plan = planCredentials({
      userId: "u1",
      templateId: "tpl_1",
      requiredCredentials: "customApi",
      rules: { customApi: { authFlow: "oauth", flowReady: false, registered: false } },
      supplied: { customApi: { token: "t" } },
      usesKnowledgeKey: false,
      knowledgeKey: null,
    });

    expect(plan.ready).toBe(false);
  });

  it("adds the knowledge credential when the template searches the person's files", () => {
    const plan = planCredentials({
      userId: "u1",
      templateId: "tpl_1",
      requiredCredentials: "",
      rules: SECRET_RULES,
      supplied: {},
      usesKnowledgeKey: true,
      knowledgeKey: "kb_123",
    });

    expect(plan).toEqual({
      ready: true,
      plans: [
        {
          credentialType: "httpHeaderAuth",
          credentialName: "u_u1_tpl_1_knowledge",
          credentialData: JSON.stringify({ name: "Authorization", value: "Bearer kb_123" }),
          role: "knowledge",
        },
      ],
    });
  });
});

const TEMPLATE_NODES = [
  {
    name: "Trigger",
    type: "n8n-nodes-base.executeWorkflowTrigger",
    parameters: {},
  },
  {
    name: "Webhook",
    type: "n8n-nodes-base.webhook",
    parameters: { path: "__MP_INSTALLATION_ID__/hook" },
    webhookId: "old-id",
  },
  {
    name: "Gemini",
    type: "@n8n/n8n-nodes-langchain.lmChatGoogleGemini",
    parameters: {},
    credentials: { googlePalmApi: { id: "tpl", name: "tpl" } },
  },
  {
    name: "Daily",
    type: "n8n-nodes-base.scheduleTrigger",
    parameters: { rule: { interval: [{ field: "days" }] } },
  },
  {
    name: "Search",
    type: "n8n-nodes-base.httpRequest",
    parameters: {
      url: "__MP_PLATFORM_URL__/api/knowledge/search",
      sendHeaders: true,
      headerParameters: {
        parameters: [
          { name: "Authorization", value: "=Bearer __MP_KNOWLEDGE_KEY__" },
          { name: "X-Trace", value: "1" },
        ],
      },
    },
  },
];

const BASE = {
  userId: "u1",
  templateId: "tpl_1",
  installationId: "inst_7",
  platformUrl: "https://app.example.test",
  schedule: "",
  nodes: TEMPLATE_NODES,
  connections: {},
  credentialNodeMap: null,
  credentials: {},
  knowledgeCredential: null,
};

type Node = { name: string; type: string; webhookId?: string; credentials?: unknown; parameters: Record<string, unknown> };
const nodeNamed = (nodes: unknown[], name: string) => (nodes as Node[]).find((n) => n.name === name)!;

describe("buildInstanceWorkflow", () => {
  it("names the copy for the person and the template, with the instance settings", () => {
    const copy = buildInstanceWorkflow({ ...BASE, knowledgeCredential: { id: "kc", name: "k" } });
    expect(copy.name).toBe("u_u1_tpl_1");
    expect(copy.settings).toMatchObject({ executionOrder: "v1", timezone: "Asia/Riyadh" });
  });

  it("fills in the installation id and the platform address", () => {
    const copy = buildInstanceWorkflow({ ...BASE, knowledgeCredential: { id: "kc", name: "k" } });
    const path = (nodeNamed(copy.nodes, "Webhook").parameters as { path: string }).path;
    expect(path).toBe("inst_7/hook");
    expect(nodeNamed(copy.nodes, "Search").parameters.url).toBe("https://app.example.test/api/knowledge/search");
  });

  it("gives each webhook a new id and leaves the executeWorkflow trigger alone", () => {
    const copy = buildInstanceWorkflow({ ...BASE, knowledgeCredential: { id: "kc", name: "k" } });
    expect(nodeNamed(copy.nodes, "Webhook").webhookId).not.toBe("old-id");
    expect(nodeNamed(copy.nodes, "Trigger").webhookId).toBeUndefined();
  });

  it("binds only the credentials this copy created, by node", () => {
    const copy = buildInstanceWorkflow({
      ...BASE,
      credentialNodeMap: JSON.stringify({ Gemini: ["googlePalmApi"] }),
      credentials: { googlePalmApi: { id: "c1", name: "u_u1_tpl_1_googlePalmApi" } },
      knowledgeCredential: { id: "kc", name: "k" },
    });
    expect(nodeNamed(copy.nodes, "Gemini").credentials).toEqual({
      googlePalmApi: { id: "c1", name: "u_u1_tpl_1_googlePalmApi" },
    });
  });

  it("sets the schedule on the schedule trigger when one was chosen", () => {
    const copy = buildInstanceWorkflow({ ...BASE, schedule: " 0 7 * * * ", knowledgeCredential: { id: "kc", name: "k" } });
    expect(nodeNamed(copy.nodes, "Daily").parameters.rule).toEqual({
      interval: [{ field: "cronExpression", expression: "0 7 * * *" }],
    });
  });

  it("moves the knowledge key out of the header into its credential", () => {
    const copy = buildInstanceWorkflow({ ...BASE, knowledgeCredential: { id: "kc", name: "u_u1_tpl_1_knowledge" } });
    const search = nodeNamed(copy.nodes, "Search");
    expect(JSON.stringify(search)).not.toContain("__MP_KNOWLEDGE_KEY__");
    expect(search.parameters.headerParameters).toEqual({ parameters: [{ name: "X-Trace", value: "1" }] });
    expect(search.parameters.genericAuthType).toBe("httpHeaderAuth");
    expect(search.credentials).toEqual({ httpHeaderAuth: { id: "kc", name: "u_u1_tpl_1_knowledge" } });
  });

  it("removes the header block entirely when the knowledge key was its only header", () => {
    const nodes = [
      {
        name: "Only",
        type: "n8n-nodes-base.httpRequest",
        parameters: { headerParameters: { parameters: [{ name: "Authorization", value: "__MP_KNOWLEDGE_KEY__" }] } },
      },
    ];
    const copy = buildInstanceWorkflow({ ...BASE, nodes, knowledgeCredential: { id: "kc", name: "k" } });
    const only = nodeNamed(copy.nodes, "Only");
    expect(only.parameters.headerParameters).toBeUndefined();
    expect(only.parameters.sendHeaders).toBe(false);
  });

  it("refuses a template that needs the knowledge key but has no key for this installation", () => {
    expect(() => buildInstanceWorkflow({ ...BASE, knowledgeCredential: null })).toThrow(
      "Template needs a knowledge key",
    );
  });

  it("refuses a template that puts the knowledge key anywhere but a header", () => {
    const nodes = [{ name: "Inline", type: "n8n-nodes-base.set", parameters: { value: "__MP_KNOWLEDGE_KEY__" } }];
    expect(() =>
      buildInstanceWorkflow({ ...BASE, nodes, knowledgeCredential: { id: "kc", name: "k" } }),
    ).toThrow("only supported in an HTTP header");
  });
});
