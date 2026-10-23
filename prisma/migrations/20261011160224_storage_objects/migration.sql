-- Files a product writes for one installation on the platform's own storage. Additive:
-- a new table, nothing existing changes.

-- CreateTable
CREATE TABLE "StorageObject" (
    "id" TEXT NOT NULL,
    "installationId" TEXT NOT NULL,
    "path" TEXT NOT NULL,
    "mimeType" TEXT NOT NULL,
    "size" INTEGER NOT NULL,
    "content" BYTEA NOT NULL,
    "writtenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "StorageObject_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "StorageObject_installationId_path_key" ON "StorageObject"("installationId", "path");

-- AddForeignKey
ALTER TABLE "StorageObject" ADD CONSTRAINT "StorageObject_installationId_fkey" FOREIGN KEY ("installationId") REFERENCES "Installation"("id") ON DELETE CASCADE ON UPDATE CASCADE;
