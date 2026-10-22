import "server-only";
import { createHmac, timingSafeEqual } from "node:crypto";
import { env } from "@/lib/env";

/**
 * A short-lived link to one of a person's saved files, for the assistant or a
 * workflow to fetch the original (to upload a CV to a job site, say). The link is
 * signed with AUTH_SECRET over the file id and its expiry, so it opens that one
 * file only, and only until it expires. Nothing is stored for it.
 */

export const FILE_LINK_TTL_MS = 2 * 60 * 60 * 1000;

function signature(fileId: string, expires: number): string {
  return createHmac("sha256", env.authSecret).update(`user-file:${fileId}:${expires}`).digest("base64url");
}

/** The download link for a file, or null when the app's public address is unknown. */
export function fileDownloadUrl(fileId: string, origin = env.publicUrl, now = Date.now()): string | null {
  if (!origin) return null;
  const expires = now + FILE_LINK_TTL_MS;
  const url = new URL(`/api/files/${encodeURIComponent(fileId)}/download`, origin);
  url.searchParams.set("exp", String(expires));
  url.searchParams.set("sig", signature(fileId, expires));
  return url.toString();
}

/** Whether a link's signature is right for this file and it has not expired. */
export function fileLinkValid(fileId: string, exp: string | null, sig: string | null, now = Date.now()): boolean {
  const expires = Number(exp);
  if (!Number.isFinite(expires) || expires <= now || !sig) return false;
  const expected = Buffer.from(signature(fileId, expires));
  const given = Buffer.from(sig);
  return expected.length === given.length && timingSafeEqual(expected, given);
}
