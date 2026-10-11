import "server-only";
import { randomBytes } from "node:crypto";
import { n8n } from "@/lib/n8n";
import { buildInstanceWorkflow, planCredentials, type CreatedCredential } from "./template-install";

/**
 * Installing a template into one person's n8n instance, done by the platform: the
 * credentials are created, the copy is written from the template, and it is
 * switched on. If any step is refused, what was already created is deleted, so a
 * failed install leaves nothing behind in n8n.
 */

export type DeployInput = {
  userId: string;
  templateId: string;
  n8nWorkflowId: string;
  requiredCredentials: string[];
  schedule: string;
  supplied: Record<string, unknown>;
  knowledgeKey: string;
  platformUrl: string;
};

export type DeployResult =
  | {
      ok: true;
      installationId: string;
      instanceWorkflowId: string;
      n8nCredentialIds: string[];
      activationStatus: "active" | "activation_failed";
    }
  | { ok: false; errorText: string; missingCredentials?: string };

export async function deployCopy(input: DeployInput): Promise<DeployResult> {
  const template = await n8n.getWorkflow(input.n8nWorkflowId);
  if (!template) {
    return { ok: false, errorText: "القالب غير متاح في n8n الآن. حاول لاحقاً." };
  }

  const usesKnowledgeKey = JSON.stringify(template.nodes).includes("__MP_KNOWLEDGE_KEY__");
  const plan = planCredentials({
    userId: input.userId,
    templateId: input.templateId,
    requiredCredentials: input.requiredCredentials.join(","),
    rules: {},
    supplied: input.supplied,
    usesKnowledgeKey,
    knowledgeKey: input.knowledgeKey || null,
  });
  if (!plan.ready) {
    const missing = plan.missing.join(", ");
    return {
      ok: false,
      missingCredentials: missing,
      errorText: `لم يتم التفعيل. ناقص: ${missing}`,
    };
  }

  const installationId = `inst_${randomBytes(6).toString("base64url")}`;
  const created: string[] = [];
  const credentials: Record<string, CreatedCredential> = {};
  let knowledgeCredential: CreatedCredential | null = null;

  try {
    for (const item of plan.plans) {
      const stored = await n8n.createCredential({
        name: item.credentialName,
        type: item.credentialType,
        data: JSON.parse(item.credentialData) as Record<string, unknown>,
      });
      if (!stored) throw new Error(`n8n refused the ${item.credentialType} credential`);
      created.push(stored.id);
      const credential = { id: stored.id, name: item.credentialName };
      if (item.role === "knowledge") knowledgeCredential = credential;
      else credentials[item.credentialType] = credential;
    }

    const copy = buildInstanceWorkflow({
      userId: input.userId,
      templateId: input.templateId,
      installationId,
      platformUrl: input.platformUrl,
      schedule: input.schedule,
      nodes: template.nodes,
      connections: template.connections,
      credentialNodeMap: null,
      credentials,
      knowledgeCredential,
    });

    const workflow = await n8n.createWorkflow(copy);
    if (!workflow) throw new Error("n8n refused the workflow");

    const activation = await n8n.activateWorkflow(workflow.id);
    return {
      ok: true,
      installationId,
      instanceWorkflowId: workflow.id,
      n8nCredentialIds: created,
      activationStatus: activation.ok ? "active" : "activation_failed",
    };
  } catch (error) {
    console.error("Install on the platform failed", error instanceof Error ? error.message : "unknown");
    await Promise.all(created.map((id) => n8n.deleteCredential(id)));
    return {
      ok: false,
      errorText:
        "Setting this up failed, and nothing was installed. If you just connected an account, " +
        "remove it from Connected accounts and connect it again, then retry.",
    };
  }
}
