import "server-only";
import { prisma } from "@/lib/db";
import { env } from "@/lib/env";
import { readinessFor } from "@/lib/readiness";
import { isPlatformHeld } from "@/lib/credentials";
import { platformCredential } from "@/lib/platform-secrets";
import { installCopy } from "./install-copy";
import { newKnowledgeKey } from "./knowledge/keys";

/**
 * Gives a new person every published product that works for them without any
 * connection of their own, so the Orchestrator can call them from the first message.
 *
 * "Works without a connection" is the same test the marketplace badge uses: the
 * readiness of the product with no accounts of the person's. A product that needs
 * a folder, a connection, or a platform key that is not set is left for the person
 * to add from the marketplace. Each product runs through the same install path as
 * the wizard; a failure is logged and the next product still installs. Nothing here
 * can fail the sign-up that started it.
 */

const STORAGE = "platform";

export async function installReadyProducts(userId: string): Promise<{ installed: string[]; skipped: number }> {
  const installed: string[] = [];
  let skipped = 0;

  const storage = await prisma.storageAdapter.findUnique({ where: { backend: STORAGE } });
  if (!storage?.active) return { installed, skipped };

  const existing = await prisma.installation.findMany({ where: { userId }, select: { productId: true } });
  const have = new Set(existing.map((row) => row.productId));

  const products = await prisma.product.findMany({
    where: { status: "PUBLISHED", usesKnowledge: false },
    include: { requirements: true },
    orderBy: { createdAt: "asc" },
  });

  for (const product of products) {
    if (have.has(product.id)) continue;

    const readiness = readinessFor({
      productStatus: product.status,
      requirements: product.requirements,
      accounts: [],
    });
    const needsOwnConnection = product.requiredCredentials.some((type) => !isPlatformHeld(type));
    if (readiness.tone !== "ready" || needsOwnConnection) {
      skipped++;
      continue;
    }

    try {
      const platformTypes = [
        ...new Set([
          ...product.requirements.map((r) => r.credentialType).filter((t): t is string => !!t),
          ...product.requiredCredentials,
        ]),
      ].filter(isPlatformHeld);

      const values = new Map<string, Record<string, string>>();
      let missingKey = false;
      for (const type of platformTypes) {
        const held = await platformCredential(type);
        if (!held) {
          missingKey = true;
          break;
        }
        values.set(type, held);
      }
      if (missingKey) {
        skipped++;
        continue;
      }

      const credentialsJson = JSON.stringify(Object.fromEntries(values));
      const knowledge = newKnowledgeKey();
      const reply = await installCopy({
        userId,
        templateId: product.templateId ?? product.id,
        n8nWorkflowId: product.n8nWorkflowId ?? "",
        requiredCredentials: product.requiredCredentials,
        storageBackend: STORAGE,
        credentialsJson,
        schedule: "",
        knowledgeKey: knowledge.key,
        platformUrl: env.publicUrl,
      });
      if (!reply.ok) {
        console.error(`Auto-install of ${product.slug} refused: ${reply.errorText}`);
        continue;
      }

      const row = await prisma.installation.upsert({
        where: { userId_productId: { userId, productId: product.id } },
        create: {
          installationId: reply.installationId,
          userId,
          productId: product.id,
          pinnedVersion: product.version,
          instanceWorkflowId: reply.instanceWorkflowId,
          storageBackend: STORAGE,
          status: "ACTIVE",
          activationStatus: reply.activationStatus,
          knowledgeKeyHash: knowledge.hash,
          n8nCredentialIds: reply.n8nCredentialIds,
        },
        update: {},
      });

      for (const type of platformTypes) {
        await prisma.installationCredential.upsert({
          where: { installationId_credentialType: { installationId: row.id, credentialType: type } },
          create: { installationId: row.id, credentialType: type },
          update: {},
        });
      }
      installed.push(product.slug);
    } catch (error) {
      console.error(`Auto-install of ${product.slug} failed`, error instanceof Error ? error.message : "unknown");
    }
  }

  return { installed, skipped };
}
