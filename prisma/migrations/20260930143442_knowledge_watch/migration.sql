-- AlterEnum
ALTER TYPE "KnowledgeJobKind" ADD VALUE 'SYNC_CHANGES';

-- AlterTable
ALTER TABLE "KnowledgeSource" ADD COLUMN     "channelResourceId" TEXT,
ADD COLUMN     "folderIds" TEXT[];
