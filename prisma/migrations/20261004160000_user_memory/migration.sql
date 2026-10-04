-- Lasting facts about a person (see src/server/memory.ts). Additive.

CREATE TYPE "MemorySource" AS ENUM ('EXPLICIT', 'AUTO');

ALTER TABLE "User" ADD COLUMN "memoryAuto" BOOLEAN NOT NULL DEFAULT true;

CREATE TABLE "UserMemory" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "content" TEXT NOT NULL,
    "source" "MemorySource" NOT NULL DEFAULT 'EXPLICIT',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "UserMemory_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "UserMemory_userId_updatedAt_idx" ON "UserMemory"("userId", "updatedAt");

ALTER TABLE "UserMemory" ADD CONSTRAINT "UserMemory_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
