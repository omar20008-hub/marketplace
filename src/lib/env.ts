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

/**
 * The values .env.example ships with, which are fine on a laptop and a
 * disclosed secret anywhere else: they are in the repository, so anyone who can
 * read it can forge a session or call the token-protected endpoints.
 */
const EXAMPLE_VALUES = new Set([
  "dev-only-secret-change-me-to-something-long-and-random",
  "dev-sync-token",
  "dev-schedule-token",
]);

const MIN_SECRET_LENGTH = 24;

/**
 * Whether the checks below should run at all.
 *
 * Production, but not a production *build*. `next build` sets NODE_ENV to
 * production and then imports every route to collect its page data, so without
 * this the guards fire during the build — which is the wrong moment twice over:
 * none of these values is baked into the output, and it would mean handing the
 * machine that compiles the app the secrets belonging to the machine that runs
 * it. NEXT_PHASE is what Next sets to tell the two apart (see
 * node_modules/next/dist/build/index.js, where it is assigned
 * PHASE_PRODUCTION_BUILD).
 *
 * The cost of the exemption is that a bad secret is caught on the first boot
 * rather than at build time. It still stops the deployment — which is the
 * point — it just stops it one step later.
 */
function guardsApply(): boolean {
  return (
    process.env.NODE_ENV === "production" &&
    process.env.NEXT_PHASE !== "phase-production-build"
  );
}

/**
 * Refuses to boot in production on a secret that is not one.
 *
 * Nothing else in the codebase can catch this: every signature made with the
 * example AUTH_SECRET verifies perfectly, so the failure is silent and total.
 * It has to be caught at startup, where a deployment either comes up or does
 * not, rather than at the first forged cookie.
 *
 * Only in production, so a laptop keeps working straight after `cp .env.example
 * .env`, which is the whole reason those values exist.
 */
function refuseWeakSecret(name: string, value: string): string {
  if (!guardsApply()) return value;

  if (EXAMPLE_VALUES.has(value)) {
    throw new Error(
      `${name} is still the value from .env.example, which is public. ` +
        "Generate one with:\n" +
        `  node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"`,
    );
  }

  if (value.length < MIN_SECRET_LENGTH) {
    throw new Error(
      `${name} is ${value.length} characters. In production it must be at ` +
        `least ${MIN_SECRET_LENGTH}, and should be random rather than chosen.`,
    );
  }

  return value;
}

/**
 * A token whose job is to keep strangers out of an endpoint. Empty is allowed —
 * it disables the endpoint, which is the safe reading — but the example value
 * is not, because that reads as protected while being public.
 */
function refuseExampleToken(name: string, value: string): string {
  if (!guardsApply()) return value;
  if (value !== "" && EXAMPLE_VALUES.has(value)) {
    throw new Error(
      `${name} is still the value from .env.example, which is public. ` +
        "Set a real one, or leave it empty to disable the endpoint.",
    );
  }
  return value;
}

export type N8nDriver = "mock" | "live";

export const env = {
  databaseUrl: required("DATABASE_URL", process.env.DATABASE_URL),
  authSecret: refuseWeakSecret(
    "AUTH_SECRET",
    required("AUTH_SECRET", process.env.AUTH_SECRET),
  ),
  /**
   * Encrypts connected-account credentials at rest. See lib/secrets.ts, which
   * also insists on exactly 32 bytes of hex before it will use it.
   */
  secretsKey: refuseWeakSecret(
    "SECRETS_KEY",
    required("SECRETS_KEY", process.env.SECRETS_KEY),
  ),

  /**
   * Authorises the scheduler heartbeat at POST /api/schedules/tick. Whatever
   * calls it — a cron daemon, a platform cron, an n8n Schedule Trigger — sends
   * this as x-schedule-token. Empty disables the endpoint outright rather than
   * leaving it open, so a deployment that forgets to set it does not hand
   * anyone the ability to spend other people's plan limits.
   */
  scheduleToken: refuseExampleToken(
    "SCHEDULE_TOKEN",
    process.env.SCHEDULE_TOKEN ?? "",
  ),

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
    syncToken: refuseExampleToken(
      "N8N_SYNC_TOKEN",
      process.env.N8N_SYNC_TOKEN ?? "",
    ),
  },
} as const;
