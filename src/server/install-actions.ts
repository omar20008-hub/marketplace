"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { prisma } from "@/lib/db";
import { requireUser } from "@/lib/auth";
import { n8n } from "@/lib/n8n";
import { openCredential, sealCredential } from "@/lib/secrets";

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
    const text = String(value);
    if (!text) continue;
    (submitted[credentialType] ??= {})[field] = text;
  }

  const existing = await prisma.connectedAccount.findMany({
    where: { userId: user.id },
  });
  const byType = new Map(existing.map((account) => [account.credentialType, account]));

  // Reuse an account the user already connected; store a new one if they just
  // filled the generated form. An existing row of the same type is updated in
  // place rather than joined by a second one — filling this form because the
  // old connection expired means replacing it, not collecting another.
  for (const [credentialType, values] of Object.entries(submitted)) {
    const already = byType.get(credentialType);
    if (already?.status === "ACTIVE") continue;

    const account = already
      ? await prisma.connectedAccount.update({
          where: { id: already.id },
          data: {
            status: "ACTIVE",
            secretJson: sealCredential(values),
            expiresAt: null,
            ...(values.accountRef ? { accountRef: values.accountRef } : {}),
          },
        })
      : await prisma.connectedAccount.create({
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

  const needed = product.requirements
    .filter((r) => r.providedBy === "USER" && r.credentialType)
    .map((r) => r.credentialType!);

  const missing = needed.filter((type) => byType.get(type)?.status !== "ACTIVE");

  // Partially ready: recorded here, not sent to n8n. Install Template refuses an
  // incomplete credential set, and rightly so — there is nothing to install yet.
  if (missing.length > 0) {
    await prisma.installation.upsert({
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
    revalidatePath("/workspace");
    redirect("/workspace");
  }

  // Decrypted here and nowhere else: the plaintext exists only for the length
  // of this call, on its way into n8n's own credential store.
  const credentialsJson = JSON.stringify(
    Object.fromEntries(
      needed.map((type) => [
        type,
        openCredential(byType.get(type)?.secretJson ?? null),
      ]),
    ),
  );

  const reply = await n8n.install({
    userId: user.id,
    templateId: product.templateId ?? product.id,
    storageBackend,
    credentialsJson,
    schedule,
  });

  if ("ok" in reply) {
    return { error: reply.errorText };
  }

  const installation = await prisma.installation.upsert({
    where: { userId_productId: { userId: user.id, productId: product.id } },
    create: {
      installationId: reply.installationId,
      userId: user.id,
      productId: product.id,
      pinnedVersion: product.version,
      instanceWorkflowId: reply.instanceWorkflowId,
      storageBackend: reply.storageBackend,
      status: "ACTIVE",
      schedule: schedule || null,
      activationStatus: reply.activationStatus,
    },
    update: {
      installationId: reply.installationId,
      instanceWorkflowId: reply.instanceWorkflowId,
      storageBackend: reply.storageBackend,
      status: "ACTIVE",
      attentionNote: null,
      schedule: schedule || null,
      activationStatus: reply.activationStatus,
    },
  });

  for (const type of needed) {
    const account = byType.get(type);
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
        accountId: account?.id,
      },
      update: { accountId: account?.id },
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
    data: { status: "UNINSTALLED", attentionNote: null },
  });

  revalidatePath("/", "layout");
}

function labelFor(credentialType: string) {
  const labels: Record<string, string> = {
    googleSheetsOAuth2Api: "Google Sheets",
    googleDriveOAuth2Api: "Google Drive",
    facebookGraphApi: "Instagram Business",
    slackApi: "Slack",
    microsoftTeamsOAuth2Api: "Microsoft Teams",
    hubspotApi: "HubSpot",
    openAiApi: "AI model",
  };
  return labels[credentialType] ?? credentialType;
}
