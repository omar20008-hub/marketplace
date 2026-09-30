-- CreateEnum
CREATE TYPE "KnowledgeSourceStatus" AS ENUM ('ACTIVE', 'NEEDS_RECONNECT', 'PAUSED');

-- CreateEnum
CREATE TYPE "KnowledgeFileStatus" AS ENUM ('PENDING', 'INDEXING', 'READY', 'FAILED', 'UNSUPPORTED', 'REMOVED');

-- CreateEnum
CREATE TYPE "KnowledgeJobKind" AS ENUM ('SYNC_SOURCE', 'INDEX_FILE');

-- CreateTable
CREATE TABLE "KnowledgeSource" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "provider" TEXT NOT NULL DEFAULT 'gdrive',
    "folderId" TEXT NOT NULL,
    "folderName" TEXT NOT NULL,
    "status" "KnowledgeSourceStatus" NOT NULL DEFAULT 'ACTIVE',
    "changesToken" TEXT,
    "channelId" TEXT,
    "channelToken" TEXT,
    "channelExpiry" TIMESTAMP(3),
    "lastSyncedAt" TIMESTAMP(3),
    "lastError" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "KnowledgeSource_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "KnowledgeFile" (
    "id" TEXT NOT NULL,
    "sourceId" TEXT NOT NULL,
    "externalId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "mimeType" TEXT NOT NULL,
    "path" TEXT,
    "webUrl" TEXT,
    "revision" TEXT NOT NULL,
    "status" "KnowledgeFileStatus" NOT NULL DEFAULT 'PENDING',
    "error" TEXT,
    "chunkCount" INTEGER NOT NULL DEFAULT 0,
    "indexedRevision" TEXT,
    "indexedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "KnowledgeFile_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "KnowledgeChunk" (
    "id" TEXT NOT NULL,
    "fileId" TEXT NOT NULL,
    "sourceId" TEXT NOT NULL,
    "ordinal" INTEGER NOT NULL,
    "content" TEXT NOT NULL,

    CONSTRAINT "KnowledgeChunk_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "KnowledgeJob" (
    "id" TEXT NOT NULL,
    "kind" "KnowledgeJobKind" NOT NULL,
    "targetId" TEXT NOT NULL,
    "dedupeKey" TEXT NOT NULL,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "runAfter" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "leasedUntil" TIMESTAMP(3),
    "rerun" BOOLEAN NOT NULL DEFAULT false,
    "lastError" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "KnowledgeJob_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "KnowledgeSource_channelId_key" ON "KnowledgeSource"("channelId");

-- CreateIndex
CREATE INDEX "KnowledgeSource_accountId_idx" ON "KnowledgeSource"("accountId");

-- CreateIndex
CREATE UNIQUE INDEX "KnowledgeSource_userId_provider_folderId_key" ON "KnowledgeSource"("userId", "provider", "folderId");

-- CreateIndex
CREATE INDEX "KnowledgeFile_sourceId_status_idx" ON "KnowledgeFile"("sourceId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "KnowledgeFile_sourceId_externalId_key" ON "KnowledgeFile"("sourceId", "externalId");

-- CreateIndex
CREATE INDEX "KnowledgeChunk_sourceId_idx" ON "KnowledgeChunk"("sourceId");

-- CreateIndex
CREATE INDEX "KnowledgeChunk_fileId_ordinal_idx" ON "KnowledgeChunk"("fileId", "ordinal");

-- CreateIndex
CREATE UNIQUE INDEX "KnowledgeJob_dedupeKey_key" ON "KnowledgeJob"("dedupeKey");

-- CreateIndex
CREATE INDEX "KnowledgeJob_runAfter_idx" ON "KnowledgeJob"("runAfter");

-- AddForeignKey
ALTER TABLE "KnowledgeSource" ADD CONSTRAINT "KnowledgeSource_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "KnowledgeSource" ADD CONSTRAINT "KnowledgeSource_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "ConnectedAccount"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "KnowledgeFile" ADD CONSTRAINT "KnowledgeFile_sourceId_fkey" FOREIGN KEY ("sourceId") REFERENCES "KnowledgeSource"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "KnowledgeChunk" ADD CONSTRAINT "KnowledgeChunk_fileId_fkey" FOREIGN KEY ("fileId") REFERENCES "KnowledgeFile"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- The embedding column needs pgvector. Added here rather than in the table above
-- so that a database without the extension still takes every other migration
-- and the deploy goes through; knowledge search then reports itself unavailable
-- (see server/knowledge/availability.ts) until the extension exists and this
-- block is run again by hand.
DO $$
BEGIN
  CREATE EXTENSION IF NOT EXISTS vector;
  ALTER TABLE "KnowledgeChunk" ADD COLUMN IF NOT EXISTS "embedding" vector(768);
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'pgvector is not available (%), knowledge search is disabled', SQLERRM;
END
$$;
