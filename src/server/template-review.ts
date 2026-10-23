import "server-only";
import { n8n } from "@/lib/n8n";

/**
 * What MP · Review did when a reviewer approved a template: refuse a template whose
 * credentials cannot be kept, otherwise switch its workflow on in n8n. The review
 * decision, the version and the product status are recorded by the platform itself
 * (admin-actions.ts) either way.
 *
 * An activation n8n refuses is logged and does not stop the approval, as the n8n
 * workflow's continue-on-error step did. The status is then wrong in n8n only, and
 * nothing a person runs depends on that switch.
 */
export async function publishTemplateWorkflow(product: {
  n8nWorkflowId: string | null;
  credentialDurability: string;
}): Promise<{ ok: true } | { ok: false; error: string }> {
  if (product.credentialDurability === "blocked") {
    return { ok: false, error: "يحتاج حسابات غير مستدامة ولا يمكن نشره" };
  }
  if (!product.n8nWorkflowId) {
    return { ok: false, error: "القالب غير موجود" };
  }
  const { ok } = await n8n.activateWorkflow(product.n8nWorkflowId);
  if (!ok) console.error("Approve: n8n did not switch the template workflow on");
  return { ok: true };
}
