-- CreateEnum
CREATE TYPE "OrchestratorPendingStatus" AS ENUM ('PENDING', 'CONSUMED');

-- CreateTable
CREATE TABLE "OrchestratorPendingAction" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "threadId" TEXT NOT NULL,
    "installationId" TEXT NOT NULL,
    "argsKey" TEXT NOT NULL,
    "proposedByMessageId" TEXT NOT NULL,
    "status" "OrchestratorPendingStatus" NOT NULL DEFAULT 'PENDING',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "OrchestratorPendingAction_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "OrchestratorPendingAction_userId_threadId_installationId_st_idx" ON "OrchestratorPendingAction"("userId", "threadId", "installationId", "status");

-- AddForeignKey
ALTER TABLE "OrchestratorPendingAction" ADD CONSTRAINT "OrchestratorPendingAction_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OrchestratorPendingAction" ADD CONSTRAINT "OrchestratorPendingAction_threadId_fkey" FOREIGN KEY ("threadId") REFERENCES "Thread"("id") ON DELETE CASCADE ON UPDATE CASCADE;

