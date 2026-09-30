import "server-only";
import { createHash, randomBytes } from "node:crypto";
import { prisma } from "@/lib/db";

/**
 * The key an installed workflow uses to search its own knowledge sources.
 *
 * It is written into that installation's n8n instance when it is built and
 * nowhere else; the platform keeps only a hash. It opens exactly one door — this
 * installation's search — so the worst a leaked key does is let someone ask
 * questions of one user's attached folders, and issuing a new one (every
 * activation does) ends it. The platform's own master token never goes near a
 * template.
 */

const PREFIX = "kb_";

export function hashKnowledgeKey(key: string): string {
  return createHash("sha256").update(key).digest("hex");
}

export function newKnowledgeKey(): { key: string; hash: string } {
  const key = PREFIX + randomBytes(32).toString("base64url");
  return { key, hash: hashKnowledgeKey(key) };
}

/** The active installation this Authorization header belongs to, or null. */
export async function installationForKey(header: string | null) {
  const match = /^Bearer (kb_[A-Za-z0-9_-]{20,})$/.exec(header ?? "");
  if (!match) return null;
  // Looked up by the hash of a high-entropy key, so there is no secret being
  // compared character by character — a match either exists or it does not.
  const installation = await prisma.installation.findUnique({
    where: { knowledgeKeyHash: hashKnowledgeKey(match[1]) },
  });
  return installation?.status === "ACTIVE" ? installation : null;
}
