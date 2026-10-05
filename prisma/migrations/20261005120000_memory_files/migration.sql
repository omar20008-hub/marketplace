-- A person's memory becomes a few text files instead of one row per sentence
-- (see src/server/memory.ts). Additive: "UserMemory" is left in place, unused.

CREATE TABLE "MemoryFile" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "content" TEXT NOT NULL DEFAULT '',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MemoryFile_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "MemoryFile_userId_name_key" ON "MemoryFile"("userId", "name");
CREATE INDEX "MemoryFile_userId_updatedAt_idx" ON "MemoryFile"("userId", "updatedAt");

ALTER TABLE "MemoryFile" ADD CONSTRAINT "MemoryFile_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- What people already have: their sentences, oldest first, as bullets in one file.
INSERT INTO "MemoryFile" ("id", "userId", "name", "content", "createdAt", "updatedAt")
SELECT gen_random_uuid()::text, "userId", 'Notes',
       string_agg('- ' || "content", E'\n' ORDER BY "createdAt"),
       CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
FROM "UserMemory"
GROUP BY "userId";
