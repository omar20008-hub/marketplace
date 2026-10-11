import "server-only";
import { prisma } from "./db";
import { env } from "./env";
import { PLATFORM_HELD_CREDENTIALS } from "./credentials";
import { decryptSecret, encryptSecret } from "./secrets";

/**
 * The platform's own keys (see PLATFORM_HELD_CREDENTIALS). Stored encrypted in
 * PlatformSecret; until an admin saves one, the environment value is used, so a
 * fresh deployment works before anyone opens the admin screen.
 *
 * Only the install path and the admin key screen call this. Values never reach a
 * page: the admin screen shows where a key comes from, never the key itself.
 */

/** Fixed per credential type; the admin types only the secret. */
const DEFAULT_FIELDS: Record<string, Record<string, string>> = {
  googlePalmApi: { host: "https://generativelanguage.googleapis.com" },
};

export type PlatformKeySource = "stored" | "environment" | "missing";

function fromEnvironment(credentialType: string): Record<string, string> | null {
  // The same key the knowledge embeddings and memory use (GEMINI_API_KEY).
  if (credentialType === "googlePalmApi" && env.embeddings.apiKey) {
    return { ...DEFAULT_FIELDS.googlePalmApi, apiKey: env.embeddings.apiKey };
  }
  return null;
}

/** The full field map a runtime needs for this credential, or null when none is set. */
export async function platformCredential(
  credentialType: string,
): Promise<Record<string, string> | null> {
  if (!PLATFORM_HELD_CREDENTIALS.has(credentialType)) return null;
  const row = await prisma.platformSecret.findUnique({ where: { name: credentialType } });
  if (row) {
    return { ...DEFAULT_FIELDS[credentialType], ...JSON.parse(decryptSecret(row.secretJson)) };
  }
  return fromEnvironment(credentialType);
}

/** Where the key comes from, for the admin screen. Never the value. */
export async function platformKeyStatus(
  credentialType: string,
): Promise<{ source: PlatformKeySource; updatedAt: Date | null }> {
  const row = await prisma.platformSecret.findUnique({
    where: { name: credentialType },
    select: { updatedAt: true },
  });
  if (row) return { source: "stored", updatedAt: row.updatedAt };
  return fromEnvironment(credentialType)
    ? { source: "environment", updatedAt: null }
    : { source: "missing", updatedAt: null };
}

export async function storePlatformSecret(
  credentialType: string,
  apiKey: string,
  actorId: string,
) {
  const secretJson = encryptSecret(JSON.stringify({ apiKey }));
  await prisma.platformSecret.upsert({
    where: { name: credentialType },
    create: { name: credentialType, secretJson, updatedById: actorId },
    update: { secretJson, updatedById: actorId },
  });
}
