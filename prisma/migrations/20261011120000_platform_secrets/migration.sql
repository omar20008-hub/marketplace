-- Platform-held credentials (the Gemini key the platform supplies). Additive: one new table.

-- CreateTable
CREATE TABLE "PlatformSecret" (
    "name" TEXT NOT NULL,
    "secretJson" TEXT NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "updatedById" TEXT,

    CONSTRAINT "PlatformSecret_pkey" PRIMARY KEY ("name")
);
