import { deployCopy } from "./template-deploy";
import { n8n } from "@/lib/n8n";
import { env } from "@/lib/env";

export type InstallReply =
  | {
      ok: true;
      installationId: string;
      instanceWorkflowId: string;
      activationStatus: "active" | "activation_failed";
      n8nCredentialIds: string[];
    }
  | { ok: false; errorText: string };

/**
 * Creates the person's copy by whichever driver is selected. The n8n path keeps its
 * own refusal texts; the platform path gets the same reply shape.
 */
export async function installCopy(input: {
  userId: string;
  templateId: string;
  n8nWorkflowId: string;
  requiredCredentials: string[];
  storageBackend: string;
  credentialsJson: string;
  schedule: string;
  knowledgeKey: string;
  platformUrl: string;
}): Promise<InstallReply> {
  if (env.template.driver === "platform") {
    if (input.storageBackend !== "platform") {
      return { ok: false, errorText: `Installing to "${input.storageBackend}" is not supported on the platform yet.` };
    }
    const result = await deployCopy({
      userId: input.userId,
      templateId: input.templateId,
      n8nWorkflowId: input.n8nWorkflowId,
      requiredCredentials: input.requiredCredentials,
      schedule: input.schedule,
      supplied: JSON.parse(input.credentialsJson) as Record<string, unknown>,
      knowledgeKey: input.knowledgeKey,
      platformUrl: input.platformUrl,
    });
    return result.ok ? result : { ok: false, errorText: result.errorText };
  }

  try {
    const reply = await n8n.install({
      userId: input.userId,
      templateId: input.templateId,
      storageBackend: input.storageBackend,
      credentialsJson: input.credentialsJson,
      schedule: input.schedule,
      knowledgeKey: input.knowledgeKey,
      platformUrl: input.platformUrl,
    });
    if ("ok" in reply) return { ok: false, errorText: reply.errorText };
    return {
      ok: true,
      installationId: reply.installationId,
      instanceWorkflowId: reply.instanceWorkflowId,
      activationStatus: reply.activationStatus,
      n8nCredentialIds: [],
    };
  } catch (error) {
    console.error("Install Template failed", error instanceof Error ? error.message : "unknown");
    return {
      ok: false,
      errorText:
        "Setting this up failed, and nothing was installed. If you just connected an account, " +
        "remove it from Connectors and connect it again, then retry.",
    };
  }
}
