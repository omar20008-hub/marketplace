import { z } from "zod";

/**
 * The eight workflows, transcribed from the engineering handover reference.
 *
 * Nothing here re-implements what n8n already does. The template safety scan,
 * the durability rule, building the user's instance, executing a tool and the
 * conversation logic all live inside n8n and are tested there. This file only
 * describes the shape of the traffic across the boundary.
 */

// ------------------------------------------- MP · Upload & Provision (C4hL…)

export const UploadInput = z.object({
  creatorId: z.string().min(1),
  title: z.string().min(1),
  description: z.string().min(1),
  actionType: z.enum(["read", "write"]),
  /** A fully exported n8n workflow. Must begin with an Execute Workflow Trigger. */
  file: z.string().min(1),
});
export type UploadInput = z.infer<typeof UploadInput>;

export const UploadAccepted = z.object({
  templateId: z.string(),
  status: z.literal("in_review"),
  nodeCount: z.number(),
  /** Comma-separated in the workflow's reply; split before use. */
  flaggedNodes: z.string().default(""),
  requiredCredentials: z.string().default(""),
  credentialDurability: z.enum(["durable", "blocked"]),
  externalHosts: z.string().default(""),
});

export const UploadRejected = z.object({
  ok: z.literal(false),
  errorText: z.string(),
});

export const UploadOutput = z.union([UploadAccepted, UploadRejected]);
export type UploadOutput = z.infer<typeof UploadOutput>;

// --------------------------------------------- MP · Install Template (WLRA…)

export const InstallInput = z.object({
  userId: z.string().min(1),
  templateId: z.string().min(1),
  storageBackend: z.string().default("platform"),
  /**
   * Raw JSON of { credentialType: { field: value } }. The handover calls this
   * the current weak point: the platform builds it from a generated field form
   * (see credentialSchema below), never from a textarea the user types into.
   */
  credentialsJson: z.string().default("{}"),
});
export type InstallInput = z.infer<typeof InstallInput>;

export const InstallSucceeded = z.object({
  installationId: z.string(),
  instanceWorkflowId: z.string(),
  storageBackend: z.string(),
  title: z.string(),
});

export const InstallFailed = z.object({
  ok: z.literal(false),
  /** One of: missing credentials, an OAuth type that has no flow yet, or an
   *  inactive storage backend. All three arrive as explanatory text. */
  missingCredentials: z.string().optional(),
  errorText: z.string(),
});

export const InstallOutput = z.union([InstallSucceeded, InstallFailed]);
export type InstallOutput = z.infer<typeof InstallOutput>;

// -------------------------------------------------- MP · Dispatcher (LDwK…)

export const DispatchInput = z.object({
  /**
   * From the authenticated session. Never from user input and never from a
   * model's output — the dispatcher's ownership check is only as good as this.
   */
  userId: z.string().min(1),
  installationId: z.string().min(1),
  args: z.record(z.string(), z.unknown()),
});
export type DispatchInput = z.infer<typeof DispatchInput>;

export const DispatchOutput = z.union([
  z.object({
    result: z.literal("success"),
    /** Tool data, capped at 4000 characters by the workflow. */
    toolOutput: z.string(),
  }),
  z.object({
    result: z.literal("incomplete"),
    missing: z.string(),
    message: z.string(),
  }),
  z.object({ result: z.literal("denied"), reason: z.string() }),
  z.object({ result: z.literal("error"), errorType: z.string() }),
]);
export type DispatchOutput = z.infer<typeof DispatchOutput>;

// ------------------------------------------------- MP · Storage API (TcF7…)

export const StorageInput = z.object({
  installationId: z.string().min(1),
  operation: z.enum(["put", "get", "list", "delete"]),
  /** Any path containing ".." is refused by the workflow before any access. */
  path: z.string(),
  content: z.string().optional(), // Base64, put only
  mimeType: z.string().optional(),
});
export type StorageInput = z.infer<typeof StorageInput>;

export type StorageOutput =
  | { ok: true; objectRef: string; size: number }
  | { ok: true; content: string; mimeType: string }
  | {
      ok: true;
      count: number;
      files: { path: string; size: number; mimeType: string }[];
    }
  | { ok: true; deleted: number }
  | { ok: false; error: string };

// ---------------------------------------------------- MP · Uninstall (cPaa…)

export const UninstallInput = z.object({
  userId: z.string().min(1),
  installationId: z.string().min(1),
  /**
   * The workflow only checks that this contains the word "نعم". The real
   * confirmation is the platform's own dialog — this field cannot carry it.
   */
  confirm: z.string(),
});
export type UninstallInput = z.infer<typeof UninstallInput>;

export type UninstallOutput =
  | { credentialCount: number }
  | { reason: string };

// ------------------------------------------------ MP · Orchestrator (64bc…)

export type ChatInput = {
  /** Must be the real authenticated user id: it decides which tools appear. */
  sessionId: string;
  chatInput: string;
};

export type ChatOutput = { output: string };

// ------------------------------------------------- n8n REST API, not a workflow

/** Shape of GET /api/v1/credentials/schema/{credentialTypeName}. */
export type CredentialSchema = {
  type: string;
  properties: Record<
    string,
    {
      type?: string;
      title?: string;
      description?: string;
      format?: string;
      default?: unknown;
    }
  >;
  required?: string[];
};

/** A row of mp_templates, as the platform mirror consumes it. */
export type TemplateRow = {
  templateId: string;
  creatorId: string;
  title: string;
  description: string;
  version: number;
  contentHash: string;
  n8nWorkflowId: string;
  inputSchema: string;
  requiredCredentials: string;
  credentialDurability: string;
  externalHosts: string;
  flaggedNodes: string;
  actionType: string;
  status: string;
  rejectionReason?: string;
  publishedAt?: string;
};

export function splitList(value: string | null | undefined): string[] {
  if (!value) return [];
  return value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}
