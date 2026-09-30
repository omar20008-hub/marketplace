import "server-only";
import { prisma } from "@/lib/db";
import { DriveError, listChanges } from "@/lib/drive";
import { GoogleAuthError } from "@/lib/google-oauth";
import { getGoogleAccessToken } from "@/server/google-account";
import { enqueue } from "./queue";
import { ensureWatch } from "./watch";

/**
 * A notification says only "something changed in this account" — Drive's change
 * feed covers the whole drive, and the folder being watched is a small part of
 * it. So this reads the feed and asks whether anything in it touches this source
 * before paying for a full re-listing.
 */

/** Whether a change concerns the source: a file it knows, a folder in its tree, or something filed in one. */
export function touchesSource(
  change: { fileId: string; parents: string[] },
  knownFileIds: Set<string>,
  folderIds: Set<string>,
): boolean {
  return (
    knownFileIds.has(change.fileId) ||
    folderIds.has(change.fileId) ||
    change.parents.some((parent) => folderIds.has(parent))
  );
}

export async function processChanges(sourceId: string): Promise<{ again?: boolean }> {
  const source = await prisma.knowledgeSource.findUnique({ where: { id: sourceId } });
  if (!source || source.status !== "ACTIVE") return {};

  let token: string;
  try {
    token = await getGoogleAccessToken(source.accountId);
  } catch (error) {
    if (error instanceof GoogleAuthError && error.permanent) {
      await prisma.knowledgeSource.update({
        where: { id: source.id },
        data: { status: "NEEDS_RECONNECT", lastError: error.message },
      });
      return {};
    }
    throw error;
  }

  // No cursor means nothing has been synced yet, or it was reset: a full sync
  // both catches up and takes a fresh cursor.
  if (!source.changesToken) {
    await ensureWatch(source.id, token);
    await enqueue("SYNC_SOURCE", source.id);
    return {};
  }

  let feed;
  try {
    feed = await listChanges(token, source.changesToken);
  } catch (error) {
    // Drive no longer honours a cursor that old. Start over from a full listing.
    if (error instanceof DriveError && (error.status === 400 || error.status === 410)) {
      await prisma.knowledgeSource.update({ where: { id: source.id }, data: { changesToken: null } });
      await enqueue("SYNC_SOURCE", source.id);
      return {};
    }
    throw error;
  }

  if (feed.changes.length > 0) {
    const known = new Set(
      (
        await prisma.knowledgeFile.findMany({
          where: { sourceId: source.id, externalId: { in: feed.changes.map((c) => c.fileId) } },
          select: { externalId: true },
        })
      ).map((f) => f.externalId),
    );
    const folders = new Set(source.folderIds);
    if (feed.changes.some((change) => touchesSource(change, known, folders))) {
      await enqueue("SYNC_SOURCE", source.id);
    }
  }

  // Saved after the sync is queued: a crash between the two repeats a sync,
  // where the other order could lose one.
  await prisma.knowledgeSource.update({
    where: { id: source.id },
    data: { changesToken: feed.nextToken },
  });
  return {};
}
