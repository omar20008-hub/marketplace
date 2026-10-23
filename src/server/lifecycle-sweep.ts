import "server-only";
import { prisma } from "@/lib/db";
import { n8n } from "@/lib/n8n";

/**
 * The daily check that ties each installed copy to the product it came from.
 *
 * A product put on security hold, or deleted, switches its copies off: the n8n
 * copy is deactivated and the installation is marked disabled, so nobody can keep
 * running it. A copy disabled after five failures in a row is only listed, for
 * someone to look at. Nothing else changes a copy's state.
 *
 * Runs against the platform's own installations. The n8n version updated n8n's
 * mirror table, which the platform never read, so an installation could stay
 * active here after its product was pulled.
 */

const FAILURE_THRESHOLD = 5;

const DISABLE_REASON: Partial<Record<string, string>> = {
  SECURITY_HOLD: "إيقاف أمني للقالب",
  DELETED: "حُذف القالب",
};

export type SweepResult = {
  checked: number;
  disabled: string[];
  reported: string[];
  n8nRefused: string[];
};

export async function runLifecycleSweep(): Promise<SweepResult> {
  const installations = await prisma.installation.findMany({
    where: { status: { in: ["ACTIVE", "DISABLED"] } },
    select: {
      id: true,
      status: true,
      failureCount: true,
      instanceWorkflowId: true,
      product: { select: { status: true } },
    },
  });

  const result: SweepResult = { checked: installations.length, disabled: [], reported: [], n8nRefused: [] };

  for (const installation of installations) {
    const reason = DISABLE_REASON[installation.product.status];

    if (reason) {
      if (installation.instanceWorkflowId) {
        const { ok } = await n8n.deactivateInstance(installation.instanceWorkflowId);
        if (!ok) result.n8nRefused.push(installation.id);
      }
      await prisma.installation.update({
        where: { id: installation.id },
        data: { status: "DISABLED", attentionNote: reason },
      });
      result.disabled.push(installation.id);
      continue;
    }

    if (installation.status === "DISABLED" && installation.failureCount >= FAILURE_THRESHOLD) {
      result.reported.push(installation.id);
    }
  }

  return result;
}
