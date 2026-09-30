-- A source now belongs to an installation. Nothing before this migration could
-- create one (no screen or action attached a folder to anything), so the table
-- is empty wherever it exists; clearing it makes the NOT NULL column safe to add
-- rather than something to hope about.
DELETE FROM "KnowledgeSource";

-- DropIndex
DROP INDEX "KnowledgeSource_userId_provider_folderId_key";

-- AlterTable
ALTER TABLE "Installation" ADD COLUMN     "knowledgeKeyHash" TEXT;

-- AlterTable
ALTER TABLE "KnowledgeSource" ADD COLUMN     "installationId" TEXT NOT NULL;

-- CreateIndex
CREATE UNIQUE INDEX "Installation_knowledgeKeyHash_key" ON "Installation"("knowledgeKeyHash");

-- CreateIndex
CREATE UNIQUE INDEX "KnowledgeSource_installationId_provider_folderId_key" ON "KnowledgeSource"("installationId", "provider", "folderId");

-- AddForeignKey
ALTER TABLE "KnowledgeSource" ADD CONSTRAINT "KnowledgeSource_installationId_fkey" FOREIGN KEY ("installationId") REFERENCES "Installation"("id") ON DELETE CASCADE ON UPDATE CASCADE;

