-- CreateTable
CREATE TABLE "PlatformStatus" (
    "key" TEXT NOT NULL,
    "value" JSONB NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PlatformStatus_pkey" PRIMARY KEY ("key")
);

