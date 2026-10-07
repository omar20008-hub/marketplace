import "server-only";
import { prisma } from "@/lib/db";
import { chunkText, storableText } from "@/lib/chunking";
import { looksUnreadable, UNREADABLE_TEXT_REASON } from "@/lib/text-quality";
import { DriveError, listTree, readFileText, skipReason, UNSUPPORTED_TYPE_REASON, type DriveFile } from "@/lib/drive";
import { EmbeddingError, embedTexts, embeddingTag, toVectorLiteral } from "@/lib/embeddings";
import { GoogleAuthError } from "@/lib/google-oauth";
import { getGoogleAccessToken } from "@/server/google-account";
import { embeddingRoom, fits, WAITING_FOR_NEW_DAY } from "./embedding-budget";
import { knowledgeUsage } from "./limits";
import { classifyJobError, friendlyJobError } from "./errors";
import { enqueue } from "./queue";
import { ensureWatch } from "./watch";

/**
 * The two jobs the worker runs. Both are idempotent: run twice, the second finds
 * nothing left to do. Both return `again` when the world changed under them.
 */

export const MAX_FILES_PER_SOURCE = 2000;
const MAX_CHUNKS_PER_FILE = 3000;
/** The reason shown for a file its owner chose to leave out (see actions.ts). */
export const EXCLUDED_BY_USER = "Left out because you chose to.";
/** Texts embedded (and stored) per step; progress is saved after each, so a limit mid-file costs one step, not the file. */
const EMBED_STEP = 25;

type Outcome = { again?: boolean; /** Not a failure: run again after this many seconds, attempt not spent. */ deferSeconds?: number };

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
    const skip = skipReason(file.name, file.mimeType);

    // A file once turned away for its type, whose type is readable now (Word, Excel
    // and PowerPoint were added later): it is read after all.
    const reviving =
      !skip && existing?.status === "UNSUPPORTED" && existing.error === UNSUPPORTED_TYPE_REASON;

    if ((!existing || existing.status === "REMOVED" || reviving) && !skip) {
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
          status: skip ? "UNSUPPORTED" : "PENDING",
          error: skip,
          ...meta,
        },
      });
      if (created.status === "PENDING") toIndex.push(created.id);
    } else if (reviving) {
      await prisma.knowledgeFile.update({
        where: { id: existing.id },
        data: { revision: file.revision, status: "PENDING", error: null, indexedRevision: null, ...meta },
      });
      toIndex.push(existing.id);
    } else if (skip && !["UNSUPPORTED", "REMOVED"].includes(existing.status)) {
      // Indexed (or waiting to be) before it was known to be a scratch file: drop it.
      await markSkipped(existing.id, skip, existing.revision);
    } else if (
      existing.status === "UNSUPPORTED" &&
      existing.error === EXCLUDED_BY_USER &&
      existing.revision !== file.revision
    ) {
      // Left out on purpose: a new version of it is left out too.
      await prisma.knowledgeFile.update({
        where: { id: existing.id },
        data: { revision: file.revision, indexedRevision: file.revision, ...meta },
      });
    } else if (existing.revision !== file.revision || existing.status === "REMOVED") {
      // Changed (or returned after being removed): read it again from scratch.
      await prisma.knowledgeFile.update({
        where: { id: existing.id },
        data: {
          revision: file.revision,
          status: skip ? "UNSUPPORTED" : "PENDING",
          error: skip,
          ...meta,
        },
      });
      if (!skip) toIndex.push(existing.id);
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

async function markSkipped(fileId: string, reason: string, revision: string) {
  await prisma.$transaction([
    prisma.knowledgeChunk.deleteMany({ where: { fileId } }),
    prisma.knowledgeFile.update({
      where: { id: fileId },
      data: { status: "UNSUPPORTED", error: reason, chunkCount: 0, indexedRevision: revision },
    }),
  ]);
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

  const skip = skipReason(file.name, file.mimeType);
  if (skip) {
    await markSkipped(file.id, skip, file.revision);
    return {};
  }

  // Today's allowance spent: wait for the next day rather than fail against the
  // provider's own limit. Checked before reading the file, which would be wasted.
  const room = await embeddingRoom();
  if (room.limit && room.remaining <= 0) return waitForNewDay(file.id, room.secondsToReset);

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

    if (looksUnreadable(text.text)) {
      await markSkipped(file.id, UNREADABLE_TEXT_REASON, revision);
      return {};
    }
    const chunks = chunkText(storableText(text.text)).slice(0, MAX_CHUNKS_PER_FILE);

    // Carry on after the chunks an earlier, rate-limited pass already stored — if it
    // was for this very revision and this very text. Anything else starts over.
    const marker = `${revision}:${chunks.length}`;
    let done = 0;
    if (file.partialRevision === marker) {
      const stored = await prisma.knowledgeChunk.aggregate({
        where: { fileId: file.id },
        _count: true,
        _max: { ordinal: true },
      });
      if (stored._count > 0 && stored._max.ordinal === stored._count - 1) done = stored._count;
    }
    if (done === 0) {
      await prisma.$transaction([
        prisma.knowledgeChunk.deleteMany({ where: { fileId: file.id } }),
        prisma.knowledgeFile.update({ where: { id: file.id }, data: { partialRevision: marker } }),
      ]);
    }

    if (!fits(room, chunks.length - done)) {
      return waitForNewDay(file.id, room.secondsToReset);
    }

    let storedThisPass = 0;
    for (let i = done; i < chunks.length; i += EMBED_STEP) {
      const slice = chunks.slice(i, i + EMBED_STEP);
      let vectors: number[][];
      try {
        // A short header makes each chunk say where it came from, which helps both
        // the embedding and the model reading it.
        vectors = await embedTexts(slice.map((chunk) => `${file.name}\n\n${chunk}`), "document");
      } catch (error) {
        // The provider's *daily* quota is spent: nothing will pass until it turns over
        // at midnight Pacific, so wait for that on purpose (what is stored stays)
        // instead of knocking again every few minutes and failing the file in the end.
        if (error instanceof EmbeddingError && error.limit?.quota === "day") {
          return waitForNewDay(file.id, room.secondsToReset);
        }
        // Stopped by a rate limit part-way: what is stored stays, and the next pass
        // resumes. That is progress, not a failure, so it does not spend an attempt.
        if (error instanceof EmbeddingError && error.retryable && storedThisPass > 0) {
          await prisma.knowledgeFile.update({
            where: { id: file.id },
            data: {
              status: "PENDING",
              error: friendlyJobError(classifyJobError(error), false) ?? "Retrying after a temporary problem.",
            },
          });
          return { deferSeconds: error.limit?.retryAfterSeconds ?? 60 };
        }
        throw error;
      }
      await prisma.$executeRaw`
        INSERT INTO "KnowledgeChunk" (id, "fileId", "sourceId", ordinal, content, embedding)
        SELECT gen_random_uuid()::text, ${file.id}, ${file.sourceId}, t.ord, t.content, t.vec::vector
        FROM unnest(${slice}::text[], ${slice.map((_, k) => i + k)}::int[],
                    ${vectors.map(toVectorLiteral)}::text[])
             AS t(content, ord, vec)`;
      storedThisPass += slice.length;
    }

    await prisma.knowledgeFile.update({
      where: { id: file.id },
      data: {
        status: "READY",
        error: null,
        chunkCount: chunks.length,
        indexedRevision: revision,
        partialRevision: null,
        indexedAt: new Date(),
        embeddingModel: embeddingTag(),
      },
    });
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
      data: {
        status: "PENDING",
        error: friendlyJobError(classifyJobError(error), false) ?? "Retrying after a temporary problem.",
      },
    });
    throw error;
  }

  const now = await prisma.knowledgeFile.findUnique({ where: { id: file.id }, select: { revision: true } });
  return { again: now !== null && now.revision !== revision };
}

async function waitForNewDay(fileId: string, secondsToReset: number): Promise<Outcome> {
  await prisma.knowledgeFile.update({
    where: { id: fileId },
    data: { status: "PENDING", error: WAITING_FOR_NEW_DAY },
  });
  return { deferSeconds: secondsToReset + 60 };
}

/** The worker gave up on a file after its retries. */
export async function giveUpOnFile(fileId: string, message: string) {
  await prisma.knowledgeFile.updateMany({
    where: { id: fileId },
    data: { status: "FAILED", error: message.slice(0, 300) },
  });
}
