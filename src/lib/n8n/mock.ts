import "server-only";
import { createHash, randomBytes } from "node:crypto";
import type { N8nDriver } from "./driver";
import type {
  ChatInput,
  ChatOutput,
  CredentialSchema,
  DispatchInput,
  DispatchOutput,
  InstallInput,
  InstallOutput,
  StorageInput,
  StorageOutput,
  TemplateRow,
  UninstallInput,
  UninstallOutput,
  UploadInput,
  UploadOutput,
} from "./contracts";

/**
 * An in-process stand-in for the eight workflows.
 *
 * It is deliberately not a stub that always says yes. It enforces the same rules
 * the real workflows enforce — the structural condition on the uploaded file,
 * the node whitelist, the OAuth durability rule, the ownership check, the
 * deterministic argument validator and the ".." path guard — so a screen that
 * behaves correctly here behaves correctly against the real instance. What it
 * cannot reproduce is the actual execution of a user's workflow, so dispatch()
 * returns a plausible payload rather than real data.
 *
 * Storage lives in memory and resets when the server restarts. Everything the
 * UI shows is in Postgres, so a restart costs nothing visible.
 */

// Mirrors mp_node_whitelist.
const DENIED_NODES = new Set([
  "n8n-nodes-base.executeCommand",
  "n8n-nodes-base.ssh",
  "n8n-nodes-base.readWriteFile",
]);

const REVIEW_NODES = new Set([
  "n8n-nodes-base.code",
  "n8n-nodes-base.httpRequest",
]);

// Mirrors mp_credential_types. flowReady is false everywhere because no OAuth
// consent flow exists yet, which is exactly why Install refuses those types.
const CREDENTIAL_TYPES: Record<
  string,
  { durability: "durable" | "blocked"; authFlow: "secret" | "oauth"; flowReady: boolean }
> = {
  googleSheetsOAuth2Api: { durability: "durable", authFlow: "oauth", flowReady: false },
  googleDriveOAuth2Api: { durability: "durable", authFlow: "oauth", flowReady: false },
  facebookGraphApi: { durability: "durable", authFlow: "secret", flowReady: true },
  slackApi: { durability: "durable", authFlow: "secret", flowReady: true },
  microsoftTeamsOAuth2Api: { durability: "durable", authFlow: "oauth", flowReady: false },
  hubspotApi: { durability: "durable", authFlow: "secret", flowReady: true },
  openAiApi: { durability: "durable", authFlow: "secret", flowReady: true },
};

const CREDENTIAL_SCHEMAS: Record<string, CredentialSchema> = {
  facebookGraphApi: {
    type: "object",
    required: ["accessToken"],
    properties: {
      accessToken: {
        type: "string",
        title: "Access token",
        format: "password",
        description: "A long-lived token for the Instagram Business account.",
      },
    },
  },
  slackApi: {
    type: "object",
    required: ["accessToken"],
    properties: {
      accessToken: { type: "string", title: "Bot token", format: "password" },
    },
  },
  hubspotApi: {
    type: "object",
    required: ["apiKey"],
    properties: {
      apiKey: { type: "string", title: "Private app token", format: "password" },
    },
  },
  openAiApi: {
    type: "object",
    required: ["apiKey"],
    properties: {
      apiKey: { type: "string", title: "API key", format: "password" },
    },
  },
};

type StoredObject = { content: string; mimeType: string; size: number };

// On the global rather than the module, because Next bundles a route handler
// and a server action separately — two module instances would mean a file
// written by a run is missing when the download route looks for it.
const globalForStorage = globalThis as unknown as {
  __mockStorage?: Map<string, Map<string, StoredObject>>;
};
const storage = (globalForStorage.__mockStorage ??= new Map<
  string,
  Map<string, StoredObject>
>());

function shortId(prefix: string) {
  return `${prefix}_${randomBytes(5).toString("hex")}`;
}

export const mockDriver: N8nDriver = {
  name: "mock",

  async upload(input: UploadInput): Promise<UploadOutput> {
    let parsed: { nodes?: { type?: string; parameters?: Record<string, unknown>; credentials?: Record<string, unknown> }[] };
    try {
      parsed = JSON.parse(input.file);
    } catch {
      return { ok: false, errorText: "The file is not valid JSON." };
    }

    const nodes = parsed.nodes ?? [];
    if (nodes.length === 0) {
      return { ok: false, errorText: "The file contains no nodes." };
    }

    // The structural condition: it must start with an Execute Workflow Trigger
    // whose inputSource is workflowInputs, with fields declared explicitly.
    const trigger = nodes.find(
      (node) => node.type === "n8n-nodes-base.executeWorkflowTrigger",
    );
    if (!trigger) {
      return {
        ok: false,
        errorText:
          "Missing the When Executed by Another Workflow trigger. A product " +
          "must start with one, with its input fields declared.",
      };
    }
    if (trigger.parameters?.inputSource !== "workflowInputs") {
      return {
        ok: false,
        errorText:
          "The trigger must use inputSource: workflowInputs with explicit fields.",
      };
    }

    const denied = nodes
      .map((node) => node.type ?? "")
      .filter((type) => DENIED_NODES.has(type));
    if (denied.length > 0) {
      return {
        ok: false,
        errorText: `Forbidden node: ${[...new Set(denied)].join(" | ")}`,
      };
    }

    const flagged = [
      ...new Set(nodes.map((n) => n.type ?? "").filter((t) => REVIEW_NODES.has(t))),
    ];

    const credentialTypes = [
      ...new Set(
        nodes.flatMap((node) => Object.keys(node.credentials ?? {})),
      ),
    ];

    // A type whose consent flow is not ready blocks publication, exactly as the
    // durability rule does in the real workflow.
    const blocked = credentialTypes.some((type) => {
      const rule = CREDENTIAL_TYPES[type];
      return rule ? rule.durability === "blocked" || (rule.authFlow === "oauth" && !rule.flowReady) : false;
    });

    const hosts = [
      ...new Set(
        JSON.stringify(parsed)
          .match(/https?:\/\/([a-z0-9.-]+)/gi)
          ?.map((url) => url.replace(/^https?:\/\//i, "").toLowerCase()) ?? [],
      ),
    ];

    // Mirrors how Upload & Provision now infers invocationMode. The Execute
    // Workflow Trigger is mandatory (checked above), so on_demand is always
    // one of the modes; a Schedule Trigger node alongside it adds scheduled,
    // and any other trigger-shaped node (a webhook, a Gmail trigger, …) adds
    // event. A workflow can combine these — comma-separated, not exclusive —
    // e.g. a chat agent that also reacts to an incoming event.
    const triggerTypes = nodes.map((n) => n.type ?? "").filter((t) => /trigger/i.test(t));
    const invocationModes = ["on_demand"];
    if (triggerTypes.includes("n8n-nodes-base.scheduleTrigger")) {
      invocationModes.push("scheduled");
    }
    if (triggerTypes.some((t) => t !== "n8n-nodes-base.executeWorkflowTrigger" && t !== "n8n-nodes-base.scheduleTrigger")) {
      invocationModes.push("event");
    }
    const invocationMode = invocationModes.join(",");

    const inputFields = (
      (trigger.parameters?.workflowInputs as { values?: { name?: string }[] } | undefined)
        ?.values ?? []
    )
      .map((field) => field.name ?? "")
      .filter(Boolean);

    return {
      templateId: shortId("tpl"),
      status: "in_review",
      nodeCount: nodes.length,
      flaggedNodes: flagged.join(","),
      requiredCredentials: credentialTypes.join(","),
      credentialDurability: blocked ? "blocked" : "durable",
      externalHosts: hosts.join(","),
      invocationMode,
      inputFields: inputFields.join(","),
      inferenceStatus: "confident",
      notes: "",
    };
  },

  async install(input: InstallInput): Promise<InstallOutput> {
    let credentials: Record<string, unknown>;
    try {
      credentials = JSON.parse(input.credentialsJson || "{}");
    } catch {
      return { ok: false, errorText: "credentialsJson is not valid JSON." };
    }

    const oauthNotReady = Object.keys(credentials).find((type) => {
      const rule = CREDENTIAL_TYPES[type];
      return rule?.authFlow === "oauth" && !rule.flowReady;
    });
    if (oauthNotReady) {
      return {
        ok: false,
        errorText: `${oauthNotReady} requires signing in through the platform, which is not available yet.`,
      };
    }

    return {
      installationId: shortId("inst"),
      instanceWorkflowId: `u_${input.userId}_${input.templateId}`,
      storageBackend: input.storageBackend,
      title: input.templateId,
      activationStatus: "active",
    };
  },

  async uninstall(input: UninstallInput): Promise<UninstallOutput> {
    if (!input.confirm.includes("نعم")) {
      return { reason: "لم يتم التأكيد" };
    }
    return { credentialCount: 1 };
  },

  async dispatch(input: DispatchInput): Promise<DispatchOutput> {
    // The deterministic validator: a run never starts with missing or guessed
    // values. The caller passes the template's declared fields under __schema.
    const schema = (input.args.__schema ?? []) as { name: string; required?: boolean }[];
    const missing = schema
      .filter((field) => field.required !== false)
      .filter((field) => {
        const value = input.args[field.name];
        return value === undefined || value === null || value === "";
      })
      .map((field) => field.name);

    if (missing.length > 0) {
      return {
        result: "incomplete",
        missing: missing.join(","),
        message: `Missing required input: ${missing.join(", ")}`,
      };
    }

    return {
      result: "success",
      toolOutput: JSON.stringify({
        ok: true,
        note: "Mock run. The real dispatcher executes the user's own instance.",
        received: Object.fromEntries(
          Object.entries(input.args).filter(([key]) => key !== "__schema"),
        ),
      }).slice(0, 4000),
    };
  },

  async storage(input: StorageInput): Promise<StorageOutput> {
    // The guard that exists in the real workflow: any path containing ".." is
    // refused before storage is touched at all.
    if (input.path.includes("..")) {
      return { ok: false, error: "Rejected path" };
    }

    const bucket =
      storage.get(input.installationId) ??
      storage.set(input.installationId, new Map()).get(input.installationId)!;

    switch (input.operation) {
      case "put": {
        const content = input.content ?? "";
        const size = Buffer.from(content, "base64").length;
        bucket.set(input.path, {
          content,
          mimeType: input.mimeType ?? "application/octet-stream",
          size,
        });
        return {
          ok: true,
          objectRef: `platform://${input.installationId}/${input.path}`,
          size,
        };
      }
      case "get": {
        const found = bucket.get(input.path);
        if (!found) return { ok: false, error: "الملف غير موجود" };
        return { ok: true, content: found.content, mimeType: found.mimeType };
      }
      case "list": {
        const files = [...bucket.entries()].map(([path, object]) => ({
          path,
          size: object.size,
          mimeType: object.mimeType,
        }));
        return { ok: true, count: files.length, files };
      }
      case "delete": {
        const deleted = bucket.delete(input.path) ? 1 : 0;
        return { ok: true, deleted };
      }
    }
  },

  async chat(input: ChatInput): Promise<ChatOutput> {
    // The real Orchestrator builds a tool catalogue from this user's
    // installations and refuses to invent a result. This keeps the same shape.
    return {
      output:
        `I read your workspace for ${input.sessionId} and matched your ` +
        `request to a product you already own. Ask me to run it and I will.`,
    };
  },

  async credentialSchema(credentialType: string) {
    return CREDENTIAL_SCHEMAS[credentialType] ?? null;
  },

  async listTemplates(): Promise<TemplateRow[]> {
    // In mock mode the platform's own mirror is the only catalogue there is.
    return [];
  },
};

export function contentHash(file: string) {
  return createHash("sha256").update(file).digest("hex").slice(0, 16);
}
