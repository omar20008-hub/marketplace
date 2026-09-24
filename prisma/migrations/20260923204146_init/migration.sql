-- CreateEnum
CREATE TYPE "Role" AS ENUM ('USER', 'CREATOR', 'ADMIN');

-- CreateEnum
CREATE TYPE "ProductKind" AS ENUM ('AGENT', 'WORKFLOW');

-- CreateEnum
CREATE TYPE "ActionType" AS ENUM ('READ', 'WRITE');

-- CreateEnum
CREATE TYPE "ProductStatus" AS ENUM ('DRAFT', 'IN_REVIEW', 'PUBLISHED', 'BLOCKED_DURABILITY', 'WITHDRAWN', 'DELETED', 'SECURITY_HOLD', 'RESTRICTED', 'SUSPENDED');

-- CreateEnum
CREATE TYPE "ProvidedBy" AS ENUM ('PLATFORM', 'PLATFORM_OR_OWN', 'USER');

-- CreateEnum
CREATE TYPE "RequirementKind" AS ENUM ('MODEL', 'CONNECTION', 'STORAGE');

-- CreateEnum
CREATE TYPE "AccountScope" AS ENUM ('OWN', 'PLATFORM');

-- CreateEnum
CREATE TYPE "AccountStatus" AS ENUM ('ACTIVE', 'EXPIRED', 'PENDING');

-- CreateEnum
CREATE TYPE "InstallationStatus" AS ENUM ('PARTIAL', 'ACTIVE', 'DISABLED', 'UNINSTALLED');

-- CreateEnum
CREATE TYPE "RunResult" AS ENUM ('RUNNING', 'SUCCESS', 'PARTIAL', 'ERROR', 'DENIED', 'INCOMPLETE', 'BLOCKED', 'STOPPED');

-- CreateEnum
CREATE TYPE "StepStatus" AS ENUM ('QUEUED', 'RUNNING', 'DONE', 'FAILED', 'SKIPPED');

-- CreateEnum
CREATE TYPE "MessageRole" AS ENUM ('USER', 'ASSISTANT');

-- CreateEnum
CREATE TYPE "SubmissionState" AS ENUM ('VALIDATING', 'VALIDATION_FAILED', 'UNDER_REVIEW', 'CHANGES_REQUESTED', 'APPROVED', 'REJECTED');

-- CreateEnum
CREATE TYPE "CheckState" AS ENUM ('PASSED', 'PARTIAL', 'FAILED', 'HUMAN_REVIEW', 'FIXED');

-- CreateEnum
CREATE TYPE "IssueSeverity" AS ENUM ('BLOCKER', 'HUMAN_REVIEW', 'FIXED', 'QUALITY', 'POLICY');

-- CreateTable
CREATE TABLE "User" (
    "id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "passwordHash" TEXT NOT NULL,
    "roles" "Role"[] DEFAULT ARRAY['USER']::"Role"[],
    "orgName" TEXT,
    "initials" TEXT NOT NULL,
    "avatarTint" TEXT NOT NULL DEFAULT '#dfe7f5',
    "avatarInk" TEXT NOT NULL DEFAULT '#1f4f9a',
    "planId" TEXT NOT NULL,
    "renewsAt" TIMESTAMP(3),
    "credits" INTEGER NOT NULL DEFAULT 0,
    "creatorName" TEXT,
    "creatorVerified" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "User_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Plan" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "monthlyRuns" INTEGER NOT NULL,
    "storageBytes" BIGINT NOT NULL,
    "monthlyCredits" INTEGER NOT NULL,
    "priceMonthly" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "Plan_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Product" (
    "id" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "templateId" TEXT,
    "n8nWorkflowId" TEXT,
    "creatorId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "summary" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "needsFromYou" TEXT NOT NULL,
    "kind" "ProductKind" NOT NULL,
    "category" TEXT NOT NULL,
    "actionType" "ActionType" NOT NULL DEFAULT 'READ',
    "status" "ProductStatus" NOT NULL DEFAULT 'DRAFT',
    "version" TEXT NOT NULL DEFAULT '1.0',
    "contentHash" TEXT,
    "nodeCount" INTEGER NOT NULL DEFAULT 0,
    "inputSchema" JSONB NOT NULL DEFAULT '[]',
    "outputs" JSONB NOT NULL DEFAULT '[]',
    "requiredCredentials" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "externalHosts" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "flaggedNodes" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "credentialDurability" TEXT NOT NULL DEFAULT 'durable',
    "ratingAvg" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "ratingCount" INTEGER NOT NULL DEFAULT 0,
    "runsLast30d" INTEGER NOT NULL DEFAULT 0,
    "healthPct" DOUBLE PRECISION NOT NULL DEFAULT 100,
    "featured" BOOLEAN NOT NULL DEFAULT false,
    "trending" BOOLEAN NOT NULL DEFAULT false,
    "securityCheckedAt" TIMESTAMP(3),
    "platformApproved" BOOLEAN NOT NULL DEFAULT false,
    "restrictionNote" TEXT,
    "rejectionReason" TEXT,
    "publishedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Product_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ProductVersion" (
    "id" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "version" TEXT NOT NULL,
    "current" BOOLEAN NOT NULL DEFAULT false,
    "deprecated" BOOLEAN NOT NULL DEFAULT false,
    "n8nWorkflowId" TEXT,
    "publishedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ProductVersion_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Requirement" (
    "id" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "kind" "RequirementKind" NOT NULL,
    "label" TEXT NOT NULL,
    "note" TEXT,
    "credentialType" TEXT,
    "providedBy" "ProvidedBy" NOT NULL,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "Requirement_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Review" (
    "id" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "rating" INTEGER NOT NULL,
    "body" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Review_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ConnectedAccount" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "credentialType" TEXT NOT NULL,
    "displayName" TEXT NOT NULL,
    "initials" TEXT NOT NULL,
    "accountRef" TEXT,
    "scope" "AccountScope" NOT NULL DEFAULT 'OWN',
    "status" "AccountStatus" NOT NULL DEFAULT 'ACTIVE',
    "reusable" BOOLEAN NOT NULL DEFAULT true,
    "secretJson" TEXT,
    "expiresAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ConnectedAccount_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Installation" (
    "id" TEXT NOT NULL,
    "installationId" TEXT,
    "userId" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "pinnedVersion" TEXT NOT NULL,
    "instanceWorkflowId" TEXT,
    "storageBackend" TEXT NOT NULL DEFAULT 'platform',
    "status" "InstallationStatus" NOT NULL DEFAULT 'PARTIAL',
    "failureCount" INTEGER NOT NULL DEFAULT 0,
    "favourite" BOOLEAN NOT NULL DEFAULT false,
    "attentionNote" TEXT,
    "installedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastRunAt" TIMESTAMP(3),

    CONSTRAINT "Installation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "InstallationCredential" (
    "id" TEXT NOT NULL,
    "installationId" TEXT NOT NULL,
    "accountId" TEXT,
    "credentialType" TEXT NOT NULL,
    "n8nCredentialId" TEXT,

    CONSTRAINT "InstallationCredential_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "StorageAdapter" (
    "backend" TEXT NOT NULL,
    "displayName" TEXT NOT NULL,
    "adapterWorkflowId" TEXT,
    "credentialType" TEXT,
    "supportsPresign" BOOLEAN NOT NULL DEFAULT false,
    "active" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "StorageAdapter_pkey" PRIMARY KEY ("backend")
);

-- CreateTable
CREATE TABLE "Run" (
    "id" TEXT NOT NULL,
    "runId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "installationId" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "productVersion" TEXT NOT NULL,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finishedAt" TIMESTAMP(3),
    "durationMs" INTEGER,
    "result" "RunResult" NOT NULL DEFAULT 'RUNNING',
    "errorType" TEXT,
    "message" TEXT,
    "costCredits" INTEGER NOT NULL DEFAULT 0,
    "charged" BOOLEAN NOT NULL DEFAULT true,
    "chargeNote" TEXT,
    "threadId" TEXT,

    CONSTRAINT "Run_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RunStep" (
    "id" TEXT NOT NULL,
    "runId" TEXT NOT NULL,
    "idx" INTEGER NOT NULL,
    "label" TEXT NOT NULL,
    "status" "StepStatus" NOT NULL DEFAULT 'QUEUED',
    "durationMs" INTEGER,

    CONSTRAINT "RunStep_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Artifact" (
    "id" TEXT NOT NULL,
    "runId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "path" TEXT NOT NULL,
    "mimeType" TEXT NOT NULL,
    "sizeBytes" INTEGER NOT NULL,
    "backend" TEXT NOT NULL DEFAULT 'platform',
    "objectRef" TEXT NOT NULL,
    "deliveredTo" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "keepDays" INTEGER NOT NULL DEFAULT 90,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Artifact_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Thread" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Thread_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Message" (
    "id" TEXT NOT NULL,
    "threadId" TEXT NOT NULL,
    "role" "MessageRole" NOT NULL,
    "body" TEXT NOT NULL,
    "runId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Message_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Schedule" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "installationId" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "cron" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "nextRunAt" TIMESTAMP(3),
    "lastStatus" TEXT,

    CONSTRAINT "Schedule_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Submission" (
    "id" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "creatorId" TEXT NOT NULL,
    "version" TEXT NOT NULL,
    "state" "SubmissionState" NOT NULL DEFAULT 'VALIDATING',
    "submittedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "checkDurationMs" INTEGER,
    "parsing" "CheckState" NOT NULL DEFAULT 'PASSED',
    "secrets" "CheckState" NOT NULL DEFAULT 'PASSED',
    "compatibility" "CheckState" NOT NULL DEFAULT 'PASSED',
    "security" "CheckState" NOT NULL DEFAULT 'PASSED',
    "quality" "CheckState" NOT NULL DEFAULT 'PASSED',
    "policy" "CheckState" NOT NULL DEFAULT 'PASSED',
    "secretsRemoved" INTEGER NOT NULL DEFAULT 0,
    "decidedById" TEXT,
    "decidedAt" TIMESTAMP(3),
    "decisionReason" TEXT,

    CONSTRAINT "Submission_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SubmissionIssue" (
    "id" TEXT NOT NULL,
    "submissionId" TEXT NOT NULL,
    "severity" "IssueSeverity" NOT NULL,
    "title" TEXT NOT NULL,
    "detail" TEXT NOT NULL,
    "step" TEXT,
    "needsAnswer" BOOLEAN NOT NULL DEFAULT false,
    "answer" TEXT,

    CONSTRAINT "SubmissionIssue_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AuditLog" (
    "id" TEXT NOT NULL,
    "actorId" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "subject" TEXT NOT NULL,
    "reason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AuditLog_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "User_email_key" ON "User"("email");

-- CreateIndex
CREATE UNIQUE INDEX "Product_slug_key" ON "Product"("slug");

-- CreateIndex
CREATE UNIQUE INDEX "Product_templateId_key" ON "Product"("templateId");

-- CreateIndex
CREATE INDEX "Product_status_category_idx" ON "Product"("status", "category");

-- CreateIndex
CREATE UNIQUE INDEX "ProductVersion_productId_version_key" ON "ProductVersion"("productId", "version");

-- CreateIndex
CREATE UNIQUE INDEX "Review_productId_userId_key" ON "Review"("productId", "userId");

-- CreateIndex
CREATE UNIQUE INDEX "ConnectedAccount_userId_credentialType_accountRef_key" ON "ConnectedAccount"("userId", "credentialType", "accountRef");

-- CreateIndex
CREATE UNIQUE INDEX "Installation_installationId_key" ON "Installation"("installationId");

-- CreateIndex
CREATE UNIQUE INDEX "Installation_userId_productId_key" ON "Installation"("userId", "productId");

-- CreateIndex
CREATE UNIQUE INDEX "InstallationCredential_installationId_credentialType_key" ON "InstallationCredential"("installationId", "credentialType");

-- CreateIndex
CREATE UNIQUE INDEX "Run_runId_key" ON "Run"("runId");

-- CreateIndex
CREATE INDEX "Run_userId_startedAt_idx" ON "Run"("userId", "startedAt");

-- CreateIndex
CREATE UNIQUE INDEX "RunStep_runId_idx_key" ON "RunStep"("runId", "idx");

-- CreateIndex
CREATE INDEX "Thread_userId_updatedAt_idx" ON "Thread"("userId", "updatedAt");

-- CreateIndex
CREATE INDEX "AuditLog_createdAt_idx" ON "AuditLog"("createdAt");

-- AddForeignKey
ALTER TABLE "User" ADD CONSTRAINT "User_planId_fkey" FOREIGN KEY ("planId") REFERENCES "Plan"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Product" ADD CONSTRAINT "Product_creatorId_fkey" FOREIGN KEY ("creatorId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProductVersion" ADD CONSTRAINT "ProductVersion_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Requirement" ADD CONSTRAINT "Requirement_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Review" ADD CONSTRAINT "Review_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Review" ADD CONSTRAINT "Review_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ConnectedAccount" ADD CONSTRAINT "ConnectedAccount_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Installation" ADD CONSTRAINT "Installation_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Installation" ADD CONSTRAINT "Installation_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InstallationCredential" ADD CONSTRAINT "InstallationCredential_installationId_fkey" FOREIGN KEY ("installationId") REFERENCES "Installation"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InstallationCredential" ADD CONSTRAINT "InstallationCredential_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "ConnectedAccount"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Run" ADD CONSTRAINT "Run_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Run" ADD CONSTRAINT "Run_installationId_fkey" FOREIGN KEY ("installationId") REFERENCES "Installation"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Run" ADD CONSTRAINT "Run_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Run" ADD CONSTRAINT "Run_threadId_fkey" FOREIGN KEY ("threadId") REFERENCES "Thread"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RunStep" ADD CONSTRAINT "RunStep_runId_fkey" FOREIGN KEY ("runId") REFERENCES "Run"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Artifact" ADD CONSTRAINT "Artifact_runId_fkey" FOREIGN KEY ("runId") REFERENCES "Run"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Thread" ADD CONSTRAINT "Thread_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Message" ADD CONSTRAINT "Message_threadId_fkey" FOREIGN KEY ("threadId") REFERENCES "Thread"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Schedule" ADD CONSTRAINT "Schedule_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Schedule" ADD CONSTRAINT "Schedule_installationId_fkey" FOREIGN KEY ("installationId") REFERENCES "Installation"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Submission" ADD CONSTRAINT "Submission_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Submission" ADD CONSTRAINT "Submission_creatorId_fkey" FOREIGN KEY ("creatorId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SubmissionIssue" ADD CONSTRAINT "SubmissionIssue_submissionId_fkey" FOREIGN KEY ("submissionId") REFERENCES "Submission"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AuditLog" ADD CONSTRAINT "AuditLog_actorId_fkey" FOREIGN KEY ("actorId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
