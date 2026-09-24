-- AlterTable
ALTER TABLE "Schedule" ADD COLUMN     "args" JSONB NOT NULL DEFAULT '{}',
ADD COLUMN     "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
ADD COLUMN     "lastRunAt" TIMESTAMP(3),
ADD COLUMN     "lastRunId" TEXT;

-- CreateIndex
CREATE INDEX "Schedule_enabled_nextRunAt_idx" ON "Schedule"("enabled", "nextRunAt");
