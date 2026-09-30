"use server";

import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/db";
import { requireUser } from "@/lib/auth";
import { openCredential, sealCredential } from "@/lib/secrets";
import { GOOGLE_DRIVE_CREDENTIAL, revokeToken } from "@/lib/google-oauth";
import { isPlatformOAuth } from "@/lib/credentials";
import { refreshInstallationStates } from "./installation-state";

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
  if (isPlatformOAuth(credentialType)) {
    return { error: "Connect this one with the Google sign-in button." };
  }

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

  // Revoke at Google first, so "Revoke" here actually ends the access rather
  // than only forgetting the token. Best effort: it must not block disconnecting.
  if (account.credentialType === GOOGLE_DRIVE_CREDENTIAL && account.secretJson) {
    try {
      const token = openCredential(account.secretJson).refresh_token;
      if (token) await revokeToken(token);
    } catch {
      // An unreadable secret is exactly a reason to still clear it below.
    }
  }

  await prisma.connectedAccount.update({
    where: { id: account.id },
    data: { status: "PENDING", secretJson: null },
  });

  await refreshInstallationStates(user.id);
  revalidatePath("/accounts");
  revalidatePath("/workspace");
}
