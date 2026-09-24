"use server";

import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/db";
import { requireUser } from "@/lib/auth";
import { sealCredential } from "@/lib/secrets";

/**
 * Connected accounts.
 *
 * Secrets are encrypted before they touch the database (see lib/secrets.ts) and
 * never read back out here. No action in this file returns secretJson, and no
 * page selects it — so a credential cannot reach the browser even by accident.
 */

export type ConnectState = { error?: string; done?: boolean };

export async function connectAccount(
  _prev: ConnectState,
  formData: FormData,
): Promise<ConnectState> {
  const user = await requireUser();
  const credentialType = String(formData.get("credentialType") ?? "");
  const displayName = String(formData.get("displayName") ?? credentialType);
  const reusable = String(formData.get("reusable") ?? "all") === "all";

  if (!credentialType) return { error: "Pick a service to connect." };

  const values: Record<string, string> = {};
  for (const [key, value] of formData.entries()) {
    if (key.startsWith("field.")) {
      const name = key.slice("field.".length);
      if (String(value)) values[name] = String(value);
    }
  }

  if (Object.keys(values).length === 0) {
    return { error: "Fill in the connection details." };
  }

  const accountRef = values.accountRef ?? user.email;

  await prisma.connectedAccount.upsert({
    where: {
      userId_credentialType_accountRef: {
        userId: user.id,
        credentialType,
        accountRef,
      },
    },
    create: {
      userId: user.id,
      credentialType,
      displayName,
      initials: displayName.slice(0, 2),
      accountRef,
      status: "ACTIVE",
      reusable,
      secretJson: sealCredential(values),
    },
    update: {
      status: "ACTIVE",
      reusable,
      secretJson: sealCredential(values),
      expiresAt: null,
    },
  });

  // An expired connection can block an installation; clearing it may unblock one.
  await refreshInstallationStates(user.id);

  revalidatePath("/accounts");
  revalidatePath("/workspace");
  return { done: true };
}

export async function disconnectAccount(formData: FormData) {
  const user = await requireUser();
  const accountId = String(formData.get("accountId") ?? "");

  const account = await prisma.connectedAccount.findFirst({
    where: { id: accountId, userId: user.id },
  });
  if (!account || account.scope === "PLATFORM") return;

  await prisma.connectedAccount.update({
    where: { id: account.id },
    data: { status: "PENDING", secretJson: null },
  });

  await refreshInstallationStates(user.id);
  revalidatePath("/accounts");
  revalidatePath("/workspace");
}

/**
 * Keeps the workspace honest: a product whose connection just came back should
 * stop saying it needs attention, and one whose connection just went should say
 * so before the next scheduled run fails.
 */
async function refreshInstallationStates(userId: string) {
  const [installations, accounts] = await Promise.all([
    prisma.installation.findMany({
      where: { userId, status: { in: ["ACTIVE", "PARTIAL"] } },
      include: { product: { include: { requirements: true } } },
    }),
    prisma.connectedAccount.findMany({ where: { userId } }),
  ]);

  const usable = new Set(
    accounts.filter((a) => a.status === "ACTIVE").map((a) => a.credentialType),
  );

  for (const installation of installations) {
    const missing = installation.product.requirements
      .filter((r) => r.providedBy === "USER" && r.credentialType)
      .filter((r) => !usable.has(r.credentialType!))
      .map((r) => r.label);

    const isPartial = missing.length > 0;
    if (
      (isPartial && installation.status === "PARTIAL") ||
      (!isPartial && installation.status === "ACTIVE" && !installation.attentionNote)
    ) {
      continue;
    }

    await prisma.installation.update({
      where: { id: installation.id },
      data: {
        status: isPartial ? "PARTIAL" : installation.installationId ? "ACTIVE" : "PARTIAL",
        attentionNote: isPartial
          ? `${missing.join(", ")} still needs connecting.`
          : null,
      },
    });
  }
}
