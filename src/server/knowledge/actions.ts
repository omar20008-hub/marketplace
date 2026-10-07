"use server";

import { revalidatePath } from "next/cache";
import { requireUser } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { GOOGLE_DRIVE_CREDENTIAL } from "@/lib/google-oauth";
import { EXCLUDED_BY_USER } from "./indexer";
import { enqueue, expedite } from "./queue";
import { createKnowledgeSource } from "./sources";
import { stopWatch } from "./watch";

/**
 * What a user does to the folders behind an installation. Every action starts
 * from the row and checks it is theirs; an id posted from a browser is a claim,
 * not a fact.
 */

export type KnowledgeActionState = { error?: string };

async function ownedSource(userId: string, sourceId: string) {
  return prisma.knowledgeSource.findFirst({ where: { id: sourceId, userId } });
}

export async function attachFolder(
  _prev: KnowledgeActionState,
  formData: FormData,
): Promise<KnowledgeActionState> {
  const user = await requireUser();
  const installationId = String(formData.get("installationId") ?? "");
  const folderId = String(formData.get("folderId") ?? "");
  if (!folderId) return { error: "Choose a folder first." };

  const account = await prisma.connectedAccount.findFirst({
    where: { userId: user.id, credentialType: GOOGLE_DRIVE_CREDENTIAL, status: "ACTIVE" },
  });
  if (!account) return { error: "Connect your Google Drive first." };

  const result = await createKnowledgeSource(user.id, {
    installationId,
    accountId: account.id,
    folderId,
  });
  if (!result.ok) return { error: result.error };

  revalidatePath(`/workspace/${installationId}/files`);
  return {};
}

export async function syncNow(formData: FormData) {
  const user = await requireUser();
  const source = await ownedSource(user.id, String(formData.get("sourceId") ?? ""));
  if (!source) return;
  // A PAUSED source is one the user (or an uninstall) stopped; it stays stopped.
  if (source.status === "PAUSED") return;
  await enqueue("SYNC_SOURCE", source.id);
  // A file waiting out a retry backoff would otherwise sit there for up to an hour
  // after the person pressed "Check now": bring those forward too.
  const waiting = await prisma.knowledgeFile.findMany({
    where: { sourceId: source.id, status: "PENDING" },
    select: { id: true },
    take: 200,
  });
  for (const { id } of waiting) await expedite("INDEX_FILE", id);
  revalidatePath(`/workspace/${source.installationId}/files`);
}

/** A file that is waiting (a rate limit, a retry delay): try it on the next pass instead of when the backoff ends. */
export async function tryFileNow(formData: FormData) {
  const user = await requireUser();
  const file = await prisma.knowledgeFile.findFirst({
    where: { id: String(formData.get("fileId") ?? ""), source: { userId: user.id } },
    include: { source: true },
  });
  if (!file || file.status !== "PENDING" || file.source.status !== "ACTIVE") return;
  await expedite("INDEX_FILE", file.id);
  revalidatePath(`/workspace/${file.source.installationId}/files`);
}

export async function retryFile(formData: FormData) {
  const user = await requireUser();
  const file = await prisma.knowledgeFile.findFirst({
    where: { id: String(formData.get("fileId") ?? ""), source: { userId: user.id } },
    include: { source: true },
  });
  if (!file || file.status !== "FAILED") return;
  await prisma.knowledgeFile.update({ where: { id: file.id }, data: { status: "PENDING", error: null } });
  await enqueue("INDEX_FILE", file.id);
  revalidatePath(`/workspace/${file.source.installationId}/files`);
}

/**
 * Leave a file out of what the assistant reads: its chunks are deleted and it stays
 * out, new versions included, until it is used again. For a file that is not worth
 * indexing (a scan with a broken text layer, a duplicate of a better copy).
 */
export async function leaveOutFile(formData: FormData) {
  const user = await requireUser();
  const file = await prisma.knowledgeFile.findFirst({
    where: { id: String(formData.get("fileId") ?? ""), source: { userId: user.id } },
    include: { source: true },
  });
  if (!file || file.status === "REMOVED") return;
  await prisma.$transaction([
    prisma.knowledgeChunk.deleteMany({ where: { fileId: file.id } }),
    prisma.knowledgeJob.deleteMany({ where: { dedupeKey: `INDEX_FILE:${file.id}` } }),
    prisma.knowledgeFile.update({
      where: { id: file.id },
      data: {
        status: "UNSUPPORTED",
        error: EXCLUDED_BY_USER,
        chunkCount: 0,
        partialRevision: null,
        indexedRevision: file.revision,
      },
    }),
  ]);
  revalidatePath(`/workspace/${file.source.installationId}/files`);
}

/** The opposite: read a file that was left out. Only for one the owner left out, not one that cannot be read. */
export async function useFileAgain(formData: FormData) {
  const user = await requireUser();
  const file = await prisma.knowledgeFile.findFirst({
    where: { id: String(formData.get("fileId") ?? ""), source: { userId: user.id } },
    include: { source: true },
  });
  if (!file || file.status !== "UNSUPPORTED" || file.error !== EXCLUDED_BY_USER) return;
  await prisma.knowledgeFile.update({
    where: { id: file.id },
    data: { status: "PENDING", error: null, indexedRevision: null },
  });
  await enqueue("INDEX_FILE", file.id);
  revalidatePath(`/workspace/${file.source.installationId}/files`);
}

/** Stop using a folder: no more watching or syncing, and what was indexed from it is deleted. */
export async function removeSource(formData: FormData) {
  const user = await requireUser();
  const source = await ownedSource(user.id, String(formData.get("sourceId") ?? ""));
  if (!source) return;
  await stopWatch(source.id);
  // Chunks and files go with it (cascade), and any job still queued for it
  // finds nothing and ends.
  await prisma.knowledgeSource.delete({ where: { id: source.id } });
  revalidatePath(`/workspace/${source.installationId}/files`);
}
