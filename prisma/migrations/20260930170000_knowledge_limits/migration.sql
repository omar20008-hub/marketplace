-- AlterTable
ALTER TABLE "KnowledgeFile" ADD COLUMN     "embeddingModel" TEXT;

-- AlterTable
ALTER TABLE "Plan" ADD COLUMN     "knowledgeFiles" INTEGER NOT NULL DEFAULT 200,
ADD COLUMN     "knowledgeSources" INTEGER NOT NULL DEFAULT 1;


-- Limits for the plans that already exist. New columns default to the smallest
-- plan's allowance, which would quietly shrink Pro and Team on deploy.
UPDATE "Plan" SET "knowledgeSources" = 5,  "knowledgeFiles" = 5000  WHERE id = 'pro';
UPDATE "Plan" SET "knowledgeSources" = 20, "knowledgeFiles" = 50000 WHERE id = 'team';
