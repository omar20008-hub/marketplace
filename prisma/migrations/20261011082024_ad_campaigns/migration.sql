-- Additive: ads campaigns the user asks for in chat, mirrored to Meta (created PAUSED).
-- CreateEnum
CREATE TYPE "AdCampaignStatus" AS ENUM ('DRAFT', 'CREATING', 'PAUSED', 'ACTIVE', 'FINISHED', 'FAILED');

-- CreateTable
CREATE TABLE "AdCampaign" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "adAccountId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "objective" TEXT NOT NULL,
    "dailyBudgetCents" INTEGER NOT NULL,
    "startsAt" TIMESTAMP(3) NOT NULL,
    "endsAt" TIMESTAMP(3) NOT NULL,
    "targeting" JSONB NOT NULL,
    "platforms" TEXT[],
    "caption" TEXT NOT NULL,
    "linkUrl" TEXT NOT NULL,
    "mediaUrl" TEXT,
    "status" "AdCampaignStatus" NOT NULL DEFAULT 'DRAFT',
    "metaCampaignId" TEXT,
    "metaAdSetId" TEXT,
    "metaAdId" TEXT,
    "error" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AdCampaign_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "AdCampaign_userId_createdAt_idx" ON "AdCampaign"("userId", "createdAt");

-- CreateIndex
CREATE INDEX "AdCampaign_status_idx" ON "AdCampaign"("status");

-- AddForeignKey
ALTER TABLE "AdCampaign" ADD CONSTRAINT "AdCampaign_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
