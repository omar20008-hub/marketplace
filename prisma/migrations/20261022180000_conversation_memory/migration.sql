-- The conversation memory: a running summary per thread, and a vector per
-- message so the whole conversation can be searched by meaning.

-- AlterTable
ALTER TABLE "Thread" ADD COLUMN "summary" TEXT NOT NULL DEFAULT '',
ADD COLUMN "summaryUntil" TIMESTAMP(3);

-- CreateTable
CREATE TABLE "MessageEmbedding" (
    "messageId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "model" TEXT NOT NULL,

    CONSTRAINT "MessageEmbedding_pkey" PRIMARY KEY ("messageId")
);

-- CreateIndex
CREATE INDEX "MessageEmbedding_userId_idx" ON "MessageEmbedding"("userId");

-- AddForeignKey
ALTER TABLE "MessageEmbedding" ADD CONSTRAINT "MessageEmbedding_messageId_fkey" FOREIGN KEY ("messageId") REFERENCES "Message"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- The vector needs pgvector, as for KnowledgeChunk: a database without the
-- extension still takes this migration, and conversation search matches words.
DO $$
BEGIN
  CREATE EXTENSION IF NOT EXISTS vector;
  ALTER TABLE "MessageEmbedding" ADD COLUMN IF NOT EXISTS "embedding" vector(768);
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'pgvector is not available (%), conversation search matches words only', SQLERRM;
END
$$;
