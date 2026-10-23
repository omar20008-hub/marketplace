"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { prisma } from "@/lib/db";
import { requireUser } from "@/lib/auth";
import { n8n } from "@/lib/n8n";
import { openCredential, sealCredential } from "@/lib/secrets";
import { env } from "@/lib/env";
import { DriveError, getFolder } from "@/lib/drive";
import { GOOGLE_DRIVE_CREDENTIAL } from "@/lib/google-oauth";
import { getGoogleAccessToken } from "./google-account";
import { editorIsGranted, findProviderByCredentialType } from "@/lib/connectors/providers";
import { newKnowledgeKey } from "./knowledge/keys";
import { createKnowledgeSource } from "./knowledge/sources";
import { stopWatch } from "./knowledge/watch";
import { credentialLabel as labelFor, isPlatformHeld, isPlatformOAuth } from "@/lib/credentials";
import { platformCredential } from "@/lib/platform-secrets";
import { removeCopy } from "./template-deploy";
import { installCopy } from "./install-copy";

/**
 * Adding a product to the workspace.
 *
 * The handover calls the raw credentialsJson textarea the current weak point.
 * It is gone: the browser posts named fields that came from n8n's own
 * credential schema, and this action assembles the JSON the workflow expects.
 * The secret is encrypted before it is stored (see lib/secrets.ts), decrypted
 * only on the way into n8n, and never read back out to a page.
 */



export type ActivateState = { error?: string };

export async function activate(
  _prev: ActivateState,
  formData: FormData,
): Promise<ActivateState> {
  const user = await requireUser();
  const productId = String(formData.get("productId") ?? "");
  const storageBackend = String(formData.get("storageBackend") ?? "platform");
  const schedule = String(formData.get("schedule") ?? "");

  const product = await prisma.product.findUnique({
    where: { id: productId },
    include: { requirements: true },
  });
  if (!product) return { error: "That product no longer exists." };

  if (product.status !== "PUBLISHED") {
    return {
      error:
        product.status === "RESTRICTED"
          ? "This product is restricted to existing users while the creator fixes a failure."
          : "This product is not available to add right now.",
    };
  }

  const adapter = await prisma.storageAdapter.findUnique({
    where: { backend: storageBackend },
  });
  if (!adapter?.active) {
    return { error: `Storage destination "${storageBackend}" is not enabled yet.` };
  }

  // Fields arrive as cred.<credentialType>.<fieldName>.
  const submitted: Record<string, Record<string, string>> = {};
  for (const [key, value] of formData.entries()) {
    if (!key.startsWith("cred.")) continue;
    const [, credentialType, field] = key.split(".");
    if (!credentialType || !field) continue;
    // Held by the platform through its own sign-in flow; a posted form must not
    // be able to write one.
    if (isPlatformOAuth(credentialType)) continue;
    const text = String(value);
    if (!text) continue;
    (submitted[credentialType] ??= {})[field] = text;
  }

  const existing = await prisma.connector.findMany({
    where: { userId: user.id },
  });
  const byType = new Map(existing.map((account) => [account.credentialType, account]));

  // The folder a knowledge product should read. Checked now, before anything is
  // installed, so a folder that cannot be opened is said so on the wizard rather
  // than found out later in My workspace.
  const folderId = product.usesKnowledge ? String(formData.get("knowledgeFolderId") ?? "") : "";
  const driveAccount = byType.get(GOOGLE_DRIVE_CREDENTIAL);
  if (folderId) {
    if (driveAccount?.status !== "ACTIVE") {
      return { error: "Connect your Google Suite to choose a folder." };
    }
    try {
      await getFolder(await getGoogleAccessToken(driveAccount.id), folderId);
    } catch (error) {
      return {
        error:
          error instanceof DriveError && !error.retryable
            ? "That folder could not be opened with your Google account."
            : "Google Drive could not be reached. Try again in a moment.",
      };
    }
  }

  /** Attaches the chosen folder once the installation row exists. Never fails the install. */
  async function attachFolder(installationRowId: string) {
    if (!folderId || !driveAccount) return;
    const result = await createKnowledgeSource(user.id, {
      installationId: installationRowId,
      accountId: driveAccount.id,
      folderId,
    });
    if (!result.ok) {
      await prisma.installation.update({
        where: { id: installationRowId },
        data: { attentionNote: `The folder was not connected: ${result.error}` },
      });
    }
  }

  // Reuse an account the user already connected; store a new one if they just
  // filled the generated form. An existing row of the same type is updated in
  // place rather than joined by a second one — filling this form because the
  // old connection expired means replacing it, not collecting another.
  for (const [credentialType, values] of Object.entries(submitted)) {
    const already = byType.get(credentialType);
    if (already?.status === "ACTIVE") continue;

    const account = already
      ? await prisma.connector.update({
          where: { id: already.id },
          data: {
            status: "ACTIVE",
            secretJson: sealCredential(values),
            expiresAt: null,
            ...(values.accountRef ? { accountRef: values.accountRef } : {}),
          },
        })
      : await prisma.connector.create({
          data: {
            userId: user.id,
            credentialType,
            displayName: labelFor(credentialType),
            initials: labelFor(credentialType).slice(0, 2),
            accountRef: values.accountRef ?? user.email,
            status: "ACTIVE",
            secretJson: sealCredential(values),
          },
        });
    byType.set(credentialType, account);
  }

  // Platform-held connections (the Gemini key) are supplied by the platform to every
  // product, whatever a stored requirement row says, so they are never asked of the person.
  // The template's own list counts too: a platform key that no requirement row names
  // still has to reach n8n, or the install is refused as missing it.
  const needed = [
    ...new Set([
      ...product.requirements
        .filter((r) => r.credentialType && (r.providedBy === "USER" || isPlatformHeld(r.credentialType)))
        .map((r) => r.credentialType!),
      ...product.requiredCredentials.filter(isPlatformHeld),
    ]),
  ];

  const connectionFor = (type: string) =>
    byType.get(findProviderByCredentialType(type)?.sourceCredentialType ?? type);
  const missing = needed.filter((type) => {
    if (isPlatformHeld(type)) return false;
    const connection = connectionFor(type);
    const provider = findProviderByCredentialType(type);
    return (
      connection?.status !== "ACTIVE" ||
      (provider !== null && !editorIsGranted(provider, connection.secretJson))
    );
  });

  // Partially ready: recorded here, not sent to n8n. Install Template refuses an
  // incomplete credential set, and rightly so — there is nothing to install yet.
  if (missing.length > 0) {
    const partial = await prisma.installation.upsert({
      where: { userId_productId: { userId: user.id, productId: product.id } },
      create: {
        userId: user.id,
        productId: product.id,
        pinnedVersion: product.version,
        storageBackend,
        status: "PARTIAL",
        attentionNote: `${missing.map(labelFor).join(", ")} still needs connecting.`,
        schedule: schedule || null,
      },
      update: { status: "PARTIAL", storageBackend, schedule: schedule || null },
    });
    await attachFolder(partial.id);
    revalidatePath("/workspace");
    redirect("/workspace");
  }

  // Decrypted here and nowhere else: the plaintext exists only for the length
  // of this call, on its way into n8n's own credential store.
  // Connections the platform holds (Drive, and every tool it signs into) are never
  // n8n's: a workflow asks the platform for a current token when it runs. Platform
  // keys (Gemini) come from the platform's own store, not a person's account.
  const platformValues = new Map<string, Record<string, string>>();
  for (const type of needed.filter(isPlatformHeld)) {
    const values = await platformCredential(type);
    if (!values) {
      return {
        error: `${labelFor(type)} is not set up on the platform yet. An administrator needs to add its key under Platform keys.`,
      };
    }
    platformValues.set(type, values);
  }
  const credentialsJson = JSON.stringify(
    Object.fromEntries(
      needed
        .filter((type) => !isPlatformOAuth(type) && !findProviderByCredentialType(type))
        .map((type) => [
          type,
          isPlatformHeld(type)
            ? platformValues.get(type)
            : openCredential(byType.get(type)?.secretJson ?? null),
        ]),
    ),
  );

  // A new key every activation: the instance about to be built gets it, and any
  // earlier one stops working the moment the hash is replaced below.
  const knowledge = newKnowledgeKey();

  const reply = await installCopy({
    userId: user.id,
    templateId: product.templateId ?? product.id,
    n8nWorkflowId: product.n8nWorkflowId ?? "",
    requiredCredentials: product.requiredCredentials,
    storageBackend,
    credentialsJson,
    schedule,
    knowledgeKey: knowledge.key,
    platformUrl: env.publicUrl,
  });
  if (!reply.ok) return { error: reply.errorText };

  const installation = await prisma.installation.upsert({
    where: { userId_productId: { userId: user.id, productId: product.id } },
    create: {
      installationId: reply.installationId,
      userId: user.id,
      productId: product.id,
      pinnedVersion: product.version,
      instanceWorkflowId: reply.instanceWorkflowId,
      storageBackend,
      status: "ACTIVE",
      schedule: schedule || null,
      activationStatus: reply.activationStatus,
      knowledgeKeyHash: knowledge.hash,
      n8nCredentialIds: reply.n8nCredentialIds,
    },
    update: {
      installationId: reply.installationId,
      instanceWorkflowId: reply.instanceWorkflowId,
      storageBackend,
      status: "ACTIVE",
      attentionNote: null,
      schedule: schedule || null,
      activationStatus: reply.activationStatus,
      knowledgeKeyHash: knowledge.hash,
      n8nCredentialIds: reply.n8nCredentialIds,
    },
  });

  await attachFolder(installation.id);

  for (const type of needed) {
    const account = connectionFor(type);
    await prisma.installationCredential.upsert({
      where: {
        installationId_credentialType: {
          installationId: installation.id,
          credentialType: type,
        },
      },
      create: {
        installationId: installation.id,
        credentialType: type,
        connectorId: account?.id,
      },
      update: { connectorId: account?.id },
    });
  }

  revalidatePath("/", "layout");
  redirect("/workspace");
}

/**
 * Removing a product. The platform's own dialog is the real confirmation — the
 * workflow only checks that a free-text field contains a word.
 */
export async function uninstall(formData: FormData) {
  const user = await requireUser();
  const installationId = String(formData.get("installationId") ?? "");
  const confirmed = String(formData.get("confirmed") ?? "") === "yes";
  if (!confirmed) return;

  const installation = await prisma.installation.findFirst({
    where: { id: installationId, userId: user.id },
  });
  if (!installation) return;

  if (env.template.driver === "platform") {
    await removeCopy(installation);
  }

  if (installation.installationId) {
    await n8n.uninstall({
      userId: user.id,
      installationId: installation.installationId,
      confirm: "نعم",
    });
  }

  await prisma.installation.update({
    where: { id: installation.id },
    // Stored files are deliberately left alone. Deleting them is a separate
    // request the user has to make on purpose.
    // The key stops working with the status (see installationForKey). The
    // folders are dropped below, indexed content with them: unlike a run's
    // output, a copy of someone's Drive files has no screen to be managed from
    // once the installation is gone, so it does not outlive it.
    data: { status: "UNINSTALLED", attentionNote: null },
  });

  const sources = await prisma.knowledgeSource.findMany({
    where: { installationId: installation.id },
    select: { id: true },
  });
  for (const { id } of sources) {
    await stopWatch(id);
    await prisma.knowledgeSource.delete({ where: { id } });
  }

  revalidatePath("/", "layout");
}
