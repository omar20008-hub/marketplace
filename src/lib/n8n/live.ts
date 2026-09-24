import "server-only";
import { env } from "../env";
import type { N8nDriver } from "./driver";
import {
  DispatchOutput,
  InstallOutput,
  UploadOutput,
  type ChatInput,
  type ChatOutput,
  type CredentialSchema,
  type DispatchInput,
  type InstallInput,
  type StorageInput,
  type StorageOutput,
  type TemplateRow,
  type UninstallInput,
  type UninstallOutput,
  type UploadInput,
} from "./contracts";

/**
 * The real instance.
 *
 * Two open decisions from the handover shape this file, and both are marked
 * where they bite:
 *
 *  1. Upload, Install and Uninstall still use a Form Trigger, which answers with
 *     an HTML page rather than JSON. postWebhook() therefore refuses a text/html
 *     reply loudly instead of half-parsing it — switch those three to a Webhook
 *     Trigger and the same code starts working unchanged.
 *
 *  2. Dispatcher and Storage API use an Execute Workflow Trigger and have no URL
 *     at all, so they go through the REST run endpoint below. If a parallel
 *     Webhook Trigger is added to each, replace runWorkflow() with postWebhook()
 *     and nothing else changes.
 */

class N8nError extends Error {
  constructor(
    message: string,
    readonly detail?: unknown,
  ) {
    super(message);
    this.name = "N8nError";
  }
}

async function postWebhook<T>(url: string, body: unknown): Promise<T> {
  if (!url) throw new N8nError("Webhook URL is not configured");

  const response = await fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      // Header Auth on the n8n side. Without it, anyone who learns the URL can
      // call the workflow directly.
      ...(env.n8n.webhookToken
        ? { "x-platform-token": env.n8n.webhookToken }
        : {}),
    },
    body: JSON.stringify(body),
    cache: "no-store",
  });

  const contentType = response.headers.get("content-type") ?? "";
  if (contentType.includes("text/html")) {
    throw new N8nError(
      "This workflow answered with an HTML page, which means it is still on a " +
        "Form Trigger. Convert it to a Webhook Trigger so it returns JSON.",
    );
  }

  const text = await response.text();
  if (!response.ok) {
    throw new N8nError(`n8n replied ${response.status}`, text.slice(0, 500));
  }

  try {
    return JSON.parse(text) as T;
  } catch {
    throw new N8nError("n8n reply was not JSON", text.slice(0, 500));
  }
}

/**
 * POST /workflows/{id}/run — the only way to reach a workflow whose trigger is
 * Execute Workflow. Uses the API key, so it must stay server-side.
 */
async function runWorkflow<T>(
  workflowId: string,
  inputData: unknown,
): Promise<T> {
  if (!env.n8n.baseUrl || !env.n8n.apiKey) {
    throw new N8nError("N8N_BASE_URL and N8N_API_KEY are required for live mode");
  }

  const response = await fetch(
    `${env.n8n.baseUrl}/workflows/${workflowId}/run`,
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "X-N8N-API-KEY": env.n8n.apiKey,
      },
      body: JSON.stringify({ workflowData: null, runData: {}, inputData }),
      cache: "no-store",
    },
  );

  const text = await response.text();
  if (!response.ok) {
    throw new N8nError(`n8n run replied ${response.status}`, text.slice(0, 500));
  }
  return JSON.parse(text) as T;
}

async function restGet<T>(path: string): Promise<T> {
  const response = await fetch(`${env.n8n.baseUrl}${path}`, {
    headers: { "X-N8N-API-KEY": env.n8n.apiKey },
    cache: "no-store",
  });
  if (!response.ok) {
    throw new N8nError(`n8n GET ${path} replied ${response.status}`);
  }
  return (await response.json()) as T;
}

export const liveDriver: N8nDriver = {
  name: "live",

  async upload(input: UploadInput) {
    const raw = await postWebhook<unknown>(env.n8n.uploadWebhookUrl, input);
    return UploadOutput.parse(raw);
  },

  async install(input: InstallInput) {
    const raw = await postWebhook<unknown>(env.n8n.installWebhookUrl, input);
    return InstallOutput.parse(raw);
  },

  async uninstall(input: UninstallInput): Promise<UninstallOutput> {
    return postWebhook<UninstallOutput>(env.n8n.uninstallWebhookUrl, input);
  },

  async dispatch(input: DispatchInput) {
    const raw = await runWorkflow<unknown>(env.n8n.dispatcherWorkflowId, input);
    return DispatchOutput.parse(raw);
  },

  async storage(input: StorageInput): Promise<StorageOutput> {
    return runWorkflow<StorageOutput>(env.n8n.storageWorkflowId, input);
  },

  async chat(input: ChatInput): Promise<ChatOutput> {
    // responseMode is streaming; this collects it into one reply. A custom chat
    // UI that wants tokens as they arrive should read the stream directly.
    const response = await fetch(env.n8n.orchestratorChatUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(input),
      cache: "no-store",
    });
    const text = await response.text();
    try {
      const parsed = JSON.parse(text) as { output?: string };
      return { output: parsed.output ?? text };
    } catch {
      return { output: text };
    }
  },

  async credentialSchema(credentialType: string) {
    try {
      return await restGet<CredentialSchema>(
        `/credentials/schema/${encodeURIComponent(credentialType)}`,
      );
    } catch {
      return null;
    }
  },

  async listTemplates() {
    // n8n exposes Data Tables under /data-tables; the exact path moves between
    // versions, so a failure here degrades to "keep the mirror as it is" rather
    // than wiping the catalogue.
    const rows = await restGet<{ data?: TemplateRow[] }>(
      "/data-tables/mp_templates/rows?limit=500",
    );
    return rows.data ?? [];
  },
};
