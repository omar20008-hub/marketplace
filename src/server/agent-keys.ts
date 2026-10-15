import "server-only";
import { createHash, randomBytes } from "node:crypto";
import { prisma } from "@/lib/db";

/**
 * Per-person keys for the personal assistant. A key is the only thing that
 * tells the platform which person a request is for, so a body that names a
 * user id is never trusted for that. Only the SHA-256 of a key is stored; the
 * key itself is shown to the person once, when it is issued.
 */

export function hashAgentKey(key: string): string {
  return createHash("sha256").update(key).digest("hex");
}

/** Creates a new key for this person. The returned value is the only copy. */
export async function issueAgentKey(userId: string): Promise<string> {
  const key = `ak_${randomBytes(32).toString("base64url")}`;
  await prisma.agentKey.create({ data: { userId, keyHash: hashAgentKey(key) } });
  return key;
}

/** The person a key belongs to, or null for an unknown or revoked key. */
export async function userForAgentKey(key: string): Promise<string | null> {
  if (!key) return null;
  const row = await prisma.agentKey.findUnique({
    where: { keyHash: hashAgentKey(key) },
    select: { userId: true, revokedAt: true },
  });
  if (!row || row.revokedAt) return null;
  return row.userId;
}

/** Revokes every key the person holds. Used when they want the assistant cut off. */
export async function revokeAgentKeys(userId: string): Promise<void> {
  await prisma.agentKey.updateMany({
    where: { userId, revokedAt: null },
    data: { revokedAt: new Date() },
  });
}

/** The bearer token from an Authorization header, or "" when there is none. */
export function bearerToken(request: Request): string {
  const match = /^Bearer\s+(\S+)$/.exec(request.headers.get("authorization") ?? "");
  return match ? match[1] : "";
}
