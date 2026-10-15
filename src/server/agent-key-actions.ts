"use server";

import { revalidatePath } from "next/cache";
import { requireUser } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { hit } from "@/lib/rate-limit";
import { issueAgentKey, revokeAgentKeys } from "./agent-keys";

/**
 * The accounts page's personal-assistant card. The key is shown to the signed-in
 * person once, and only one key is active at a time: a new key replaces the old.
 */

export type AgentKeyState = { key?: string; error?: string };

export async function startAgentKey(): Promise<AgentKeyState> {
  const user = await requireUser();
  const limit = hit(`agent-key:${user.id}`, { limit: 5, windowMs: 60 * 60_000 });
  if (!limit.ok) {
    return { error: `Too many keys. Try again in ${Math.ceil(limit.retryAfterSeconds / 60)} min.` };
  }
  await revokeAgentKeys(user.id);
  const key = await issueAgentKey(user.id);
  await prisma.auditLog.create({
    data: { actorId: user.id, action: "agent-key.issued", subject: "personal-assistant" },
  });
  revalidatePath("/accounts");
  return { key };
}

export async function removeAgentKey(): Promise<void> {
  const user = await requireUser();
  await revokeAgentKeys(user.id);
  await prisma.auditLog.create({
    data: { actorId: user.id, action: "agent-key.revoked", subject: "personal-assistant" },
  });
  revalidatePath("/accounts");
}
