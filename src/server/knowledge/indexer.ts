import "server-only";
import { prisma } from "@/lib/db";
import { chunkText } from "@/lib/chunking";
import { DriveError, isReadable, listTree, readFileText, type DriveFile } from "@/lib/drive";
import { EmbeddingError, embedTexts, embeddingTag, toVectorLiteral } from "@/lib/embeddings";
import { GoogleAuthError } from "@/lib/google-oauth";
import { getGoogleAccessToken } from "@/server/google-account";
import { knowledgeUsage } from "./limits";
import { enqueue } from "./queue";
import { ensureWatch } from "./watch";

/**
 * The two jobs the worker runs. Both are idempotent: run twice, the second finds
 * nothing left to do. Both return `again` when the world changed under them.
 */

export const MAX_FILES_PER_SOURCE = 2000;
const MAX_CHUNKS_PER_FILE = 3000;
const INSERT_BATCH = 200;

type Outcome = { again?: boolean };

/** The connection died. Nothing is retried until the user reconnects, which resumes the source. */
async function needsReconnect(sourceId: string, error: GoogleAuthError) {
  await prisma.knowledgeSource.update({
    where: { id: sourceId },
    data: { status: "NEEDS_RECONNECT", lastError: error.message },
  });
}

export async function syncSource(sourceId: string): Promise<Outcome> {
  const source = await prisma.knowledgeSource.findUnique({ where: { id: sourceId } });
  if (!source || source.status !== "ACTIVE") return {};

  let listing;
  try {
    const token = await getGoogleAccessToken(source.accountId);
    // Before listing, so the cursor predates everything the listing will see.
    // Failing to set up push must not fail the sync: re-listing covers for it.
    await ensureWatch(source.id, token).catch((error) => {
      if (error instanceof GoogleAuthError) throw error;
      console.warn(`Drive watch for ${source.id} failed:`, (error as Error).message);
    });
    listing = await listTree(token, source.folderId, { maxFiles: MAX_FILES_PER_SOURCE });
  } catch (error) {
    if (error instanceof GoogleAuthError && error.permanent) {
      await needsReconnect(source.id, error);
      return {};
    }
    if (error instanceof DriveError && error.notFound) {
      await prisma.knowledgeSource.update({
        where: { id: source.id },
        data: { status: "PAUSED", lastError: "The folder is no longer accessible." },
      });
      return {};
    }
    throw error;
  }

  const known = new Map(
    (await prisma.knowledgeFile.findMany({ where: { sourceId: source.id } })).map((f) => [
      f.externalId,
      f,
    ]),
  );
  const seen = new Set<string>();
  const toIndex: string[] = [];

  // What the plan still allows. Only a file that would newly cost something
  // (read and embedded for the first time, or again after being removed) draws
  // on it; a file already counted, or one that changed, does not.
  const usage = await knowledgeUsage(source.userId);
  // Files leaving the folder in this same pass give their place back first, so a
  // folder that swaps one file for another is not refused for having been full.
  const present = new Set(listing.files.map((f) => f.id));
  const leaving = listing.truncated
    ? 0
    : [...known.values()].filter(
        (f) =>
          !present.has(f.externalId) &&
          ["PENDING", "INDEXING", "READY", "FAILED"].includes(f.status),
      ).length;
  let budget = Math.max(0, usage.maxFiles - usage.files + leaving);
  let turnedAway = 0;

  for (const file of listing.files) {
    seen.add(file.id);
    const existing = known.get(file.id);
    const meta = { name: file.name, mimeType: file.mimeType, path: file.path, webUrl: file.webUrl };

    if ((!existing || existing.status === "REMOVED") && isReadable(file.mimeType)) {
      if (budget <= 0) {
        turnedAway++;
        continue;
      }
      budget--;
    }

    if (!existing) {
      const created = await prisma.knowledgeFile.create({
        data: {
          sourceId: source.id,
          externalId: file.id,
          revision: file.revision,
          status: isReadable(file.mimeType) ? "PENDING" : "UNSUPPORTED",
          error: isReadable(file.mimeType) ? null : "This file type cannot be read yet.",
          ...meta,
        },
      });
      if (created.status === "PENDING") toIndex.push(created.id);
    } else if (existing.revision !== file.revision || existing.status === "REMOVED") {
      // Changed (or returned after being removed): read it again from scratch.
      await prisma.knowledgeFile.update({
        where: { id: existing.id },
        data: {
          revision: file.revision,
          status: isReadable(file.mimeType) ? "PENDING" : "UNSUPPORTED",
          error: isReadable(file.mimeType) ? null : "This file type cannot be read yet.",
          ...meta,
        },
      });
      if (isReadable(file.mimeType)) toIndex.push(existing.id);
    } else if (
      existing.name !== file.name ||
      existing.path !== file.path ||
      existing.webUrl !== file.webUrl
    ) {
      await prisma.knowledgeFile.update({ where: { id: existing.id }, data: meta });
    } else if (existing.status === "PENDING") {
      toIndex.push(existing.id); // a previous run was cut short
    }
  }

  // Gone from the folder. Not judged on a truncated listing: a file past the cap
  // is unseen, not deleted.
  if (!listing.truncated) {
    const gone = [...known.values()].filter((f) => !seen.has(f.externalId) && f.status !== "REMOVED");
    for (const file of gone) await markRemoved(file.id);
  }

  for (const id of toIndex) await enqueue("INDEX_FILE", id);

  await prisma.knowledgeSource.update({
    where: { id: source.id },
    data: {
      lastSyncedAt: new Date(),
      folderIds: listing.folders,
      lastError:
        turnedAway > 0
          ? `Your ${usage.planName} plan allows ${usage.maxFiles.toLocaleString()} files, so ${turnedAway} new file${turnedAway === 1 ? " was" : "s were"} not added. Remove files or upgrade to index more.`
          : listing.truncated
            ? `Only the first ${MAX_FILES_PER_SOURCE} files are indexed.`
            : null,
    },
  });
  return {};
}

async function markRemoved(fileId: string) {
  await prisma.$transaction([
    prisma.knowledgeChunk.deleteMany({ where: { fileId } }),
    prisma.knowledgeFile.update({
      where: { id: fileId },
      data: { status: "REMOVED", chunkCount: 0, error: null },
    }),
  ]);
}

export async function indexFile(fileId: string): Promise<Outcome> {
  const file = await prisma.knowledgeFile.findUnique({
    where: { id: fileId },
    include: { source: true },
  });
  if (!file || file.status === "REMOVED" || file.source.status !== "ACTIVE") return {};

  // The revision this pass is for. If the file moves on while it runs, the result
  // is still stored — it is not wrong, only stale — and another pass follows.
  const revision = file.revision;
  await prisma.knowledgeFile.update({ where: { id: file.id }, data: { status: "INDEXING", error: null } });

  const drive: DriveFile = {
    id: file.externalId,
    name: file.name,
    mimeType: file.mimeType,
    revision,
    webUrl: file.webUrl,
    path: file.path ?? "",
    size: null,
  };

  try {
    const token = await getGoogleAccessToken(file.source.accountId);
    const text = await readFileText(token, drive);
    if (!text.ok) {
      await prisma.$transaction([
        prisma.knowledgeChunk.deleteMany({ where: { fileId: file.id } }),
        prisma.knowledgeFile.update({
          where: { id: file.id },
          data: { status: "UNSUPPORTED", error: text.reason, chunkCount: 0, indexedRevision: revision },
        }),
      ]);
      return {};
    }

    const chunks = chunkText(text.text).slice(0, MAX_CHUNKS_PER_FILE);
    // A short header makes each chunk say where it came from, which helps both
    // the embedding and the model reading it.
    const vectors = await embedTexts(
      chunks.map((chunk) => `${file.name}\n\n${chunk}`),
      "document",
    );

    await prisma.$transaction(async (tx) => {
      await tx.knowledgeChunk.deleteMany({ where: { fileId: file.id } });
      for (let i = 0; i < chunks.length; i += INSERT_BATCH) {
        const slice = chunks.slice(i, i + INSERT_BATCH);
        await tx.$executeRaw`
          INSERT INTO "KnowledgeChunk" (id, "fileId", "sourceId", ordinal, content, embedding)
          SELECT gen_random_uuid()::text, ${file.id}, ${file.sourceId}, t.ord, t.content, t.vec::vector
          FROM unnest(${slice}::text[], ${slice.map((_, k) => i + k)}::int[],
                      ${vectors.slice(i, i + INSERT_BATCH).map(toVectorLiteral)}::text[])
               AS t(content, ord, vec)`;
      }
      await tx.knowledgeFile.update({
        where: { id: file.id },
        data: {
          status: "READY",
          error: null,
          chunkCount: chunks.length,
          indexedRevision: revision,
          indexedAt: new Date(),
          embeddingModel: embeddingTag(),
        },
      });
    }, { timeout: 60_000 });
  } catch (error) {
    if (error instanceof GoogleAuthError && error.permanent) {
      await prisma.knowledgeFile.update({ where: { id: file.id }, data: { status: "PENDING" } });
      await needsReconnect(file.sourceId, error);
      return {};
    }
    if (error instanceof DriveError && error.notFound) {
      await markRemoved(file.id);
      return {};
    }
    if (error instanceof EmbeddingError && !error.retryable) {
      await prisma.knowledgeFile.update({
        where: { id: file.id },
        data: { status: "FAILED", error: error.message },
      });
      return {};
    }
    // Retryable: leave it queued, the worker backs off. Left INDEXING it would
    // look stuck, so say what is happening.
    await prisma.knowledgeFile.update({
      where: { id: file.id },
      data: { status: "PENDING", error: "Retrying after a temporary problem." },
    });
    throw error;
  }

  const now = await prisma.knowledgeFile.findUnique({ where: { id: file.id }, select: { revision: true } });
  return { again: now !== null && now.revision !== revision };
}

/** The worker gave up on a file after its retries. */
export async function giveUpOnFile(fileId: string, message: string) {
  await prisma.knowledgeFile.updateMany({
    where: { id: fileId },
    data: { status: "FAILED", error: message.slice(0, 300) },
  });
}
