import "server-only";
import { env } from "../env";
import type { N8nDriver } from "./driver";
import {
  ApproveTemplateOutput,
  ChatOutput,
  DispatchOutput,
  InstallOutput,
  RejectTemplateOutput,
  UploadOutput,
  type ApproveTemplateInput,
  type ChatInput,
  type CredentialSchema,
  type DispatchInput,
  type InstallInput,
  type RejectTemplateInput,
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
 * Both of the handover's open decisions about this file are now settled, and
 * the instance was changed rather than the contracts:
 *
 *  1. Upload, Install and Uninstall were on a Form Trigger, which answers with
 *     an HTML page rather than JSON. They are Webhook Triggers now, and this
 *     code did not change — postWebhook() still refuses a text/html reply
 *     loudly, which is what would catch a workflow being switched back.
 *
 *  2. Dispatcher and Storage API were reachable only as sub-workflows, so they
 *     went through a REST run endpoint with the API key. Each has a parallel
 *     Webhook Trigger now, beside the Execute Workflow Trigger the Orchestrator
 *     still uses, so both go over a webhook like everything else.
 *
 * What that second change bought is worth naming: the API key is no longer on
 * any path a user can take. It is read only by the two REST helpers below,
 * which degrade quietly, so an instance can be driven with a token scoped to
 * these five workflows rather than a key that controls every workflow and
 * credential on it.
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

  async approveTemplate(input: ApproveTemplateInput) {
    const raw = await postWebhook<unknown>(env.n8n.approveTemplateWebhookUrl, input);
    return ApproveTemplateOutput.parse(raw);
  },

  async rejectTemplate(input: RejectTemplateInput) {
    const raw = await postWebhook<unknown>(env.n8n.rejectTemplateWebhookUrl, input);
    return RejectTemplateOutput.parse(raw);
  },

  /**
   * Both of these now go over a webhook, which is what the second open decision
   * anticipated: "If a parallel Webhook Trigger is added to each, replace
   * runWorkflow() with postWebhook() and nothing else changes." That trigger was
   * added, so this is that change.
   *
   * It also takes the API key off the critical path. Nothing a user does needs
   * it any more — only the two REST reads below, which degrade quietly — so an
   * instance can be driven with a token scoped to these five workflows instead
   * of a key that controls every workflow and credential on it.
   */
  async dispatch(input: DispatchInput) {
    const raw = await postWebhook<unknown>(env.n8n.dispatchWebhookUrl, input);
    return DispatchOutput.parse(raw);
  },

  async storage(input: StorageInput): Promise<StorageOutput> {
    return postWebhook<StorageOutput>(env.n8n.storageWebhookUrl, input);
  },

  async chat(input: ChatInput): Promise<ChatOutput> {
    // Goes through postWebhook like every other workflow call, so a 5xx, a
    // timeout, or the workflow answering with an HTML page all fail loudly
    // here rather than surfacing as a made-up reply. action:"sendMessage" is
    // the n8n Chat Trigger's own envelope, not this platform's invention.
    const raw = await postWebhook<unknown>(env.n8n.orchestratorChatUrl, {
      action: "sendMessage",
      sessionId: input.sessionId,
      chatInput: input.chatInput,
    });
    return ChatOutput.parse(raw);
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
