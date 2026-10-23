-- Files a person sends in a conversation (platform chat or WhatsApp), with the
-- text read from them, kept in the person's own space for later messages.

-- CreateTable
CREATE TABLE "UserFile" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "mimeType" TEXT NOT NULL,
    "sizeBytes" INTEGER NOT NULL,
    "data" BYTEA NOT NULL,
    "channel" TEXT NOT NULL DEFAULT 'platform',
    "text" TEXT NOT NULL DEFAULT '',
    "method" TEXT,
    "error" TEXT,
    "truncated" BOOLEAN NOT NULL DEFAULT false,
    "embeddingModel" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "UserFile_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "UserFileChunk" (
    "id" TEXT NOT NULL,
    "fileId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "ordinal" INTEGER NOT NULL,
    "content" TEXT NOT NULL,

    CONSTRAINT "UserFileChunk_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "UserFile_userId_createdAt_idx" ON "UserFile"("userId", "createdAt");

-- CreateIndex
CREATE INDEX "UserFileChunk_userId_idx" ON "UserFileChunk"("userId");

-- CreateIndex
CREATE INDEX "UserFileChunk_fileId_ordinal_idx" ON "UserFileChunk"("fileId", "ordinal");

-- AddForeignKey
ALTER TABLE "UserFile" ADD CONSTRAINT "UserFile_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "UserFileChunk" ADD CONSTRAINT "UserFileChunk_fileId_fkey" FOREIGN KEY ("fileId") REFERENCES "UserFile"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- The embedding column needs pgvector, as for KnowledgeChunk: a database without
-- the extension still takes this migration, and file search then matches words.
DO $$
BEGIN
  CREATE EXTENSION IF NOT EXISTS vector;
  ALTER TABLE "UserFileChunk" ADD COLUMN IF NOT EXISTS "embedding" vector(768);
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'pgvector is not available (%), file search matches words only', SQLERRM;
END
$$;
