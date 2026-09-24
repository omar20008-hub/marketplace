import "server-only";

/**
 * Every secret the platform holds is read here and nowhere else, so it is easy
 * to prove none of them reach the browser. Nothing in this file may be imported
 * from a Client Component — the "server-only" import above turns that into a
 * build error rather than a leak.
 */

function required(name: string, value: string | undefined): string {
  if (!value) {
    throw new Error(
      `Missing ${name}. Copy .env.example to .env and fill it in.`,
    );
  }
  return value;
}

export type N8nDriver = "mock" | "live";

export const env = {
  databaseUrl: required("DATABASE_URL", process.env.DATABASE_URL),
  authSecret: required("AUTH_SECRET", process.env.AUTH_SECRET),
  /** Encrypts connected-account credentials at rest. See lib/secrets.ts. */
  secretsKey: required("SECRETS_KEY", process.env.SECRETS_KEY),

  /**
   * Authorises the scheduler heartbeat at POST /api/schedules/tick. Whatever
   * calls it — a cron daemon, a platform cron, an n8n Schedule Trigger — sends
   * this as x-schedule-token. Empty disables the endpoint outright rather than
   * leaving it open, so a deployment that forgets to set it does not hand
   * anyone the ability to spend other people's plan limits.
   */
  scheduleToken: process.env.SCHEDULE_TOKEN ?? "",

  n8n: {
    driver: (process.env.N8N_DRIVER === "live" ? "live" : "mock") as N8nDriver,
    baseUrl: process.env.N8N_BASE_URL ?? "",
    /** Full control of the n8n instance. Server-side only, always. */
    apiKey: process.env.N8N_API_KEY ?? "",
    webhookToken: process.env.N8N_WEBHOOK_TOKEN ?? "",
    uploadWebhookUrl: process.env.N8N_UPLOAD_WEBHOOK_URL ?? "",
    installWebhookUrl: process.env.N8N_INSTALL_WEBHOOK_URL ?? "",
    uninstallWebhookUrl: process.env.N8N_UNINSTALL_WEBHOOK_URL ?? "",
    /**
     * Dispatcher and Storage each gained a Webhook Trigger beside the Execute
     * Workflow Trigger the Orchestrator calls them through, so the platform
     * reaches them the same way it reaches everything else. The workflow ids
     * below are what the Orchestrator still needs, and what the REST reads use.
     */
    dispatchWebhookUrl: process.env.N8N_DISPATCH_WEBHOOK_URL ?? "",
    storageWebhookUrl: process.env.N8N_STORAGE_WEBHOOK_URL ?? "",

    dispatcherWorkflowId: process.env.N8N_DISPATCHER_WORKFLOW_ID ?? "",
    storageWorkflowId: process.env.N8N_STORAGE_WORKFLOW_ID ?? "",
    orchestratorChatUrl: process.env.N8N_ORCHESTRATOR_CHAT_URL ?? "",
    syncToken: process.env.N8N_SYNC_TOKEN ?? "",
  },
} as const;
