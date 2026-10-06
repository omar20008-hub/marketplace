-- Additive: images attached in the chat, served through an unguessable link.
CREATE TABLE "MediaUpload" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "mimeType" TEXT NOT NULL,
    "sizeBytes" INTEGER NOT NULL,
    "data" BYTEA NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MediaUpload_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "MediaUpload_tokenHash_key" ON "MediaUpload"("tokenHash");
CREATE INDEX "MediaUpload_userId_expiresAt_idx" ON "MediaUpload"("userId", "expiresAt");
CREATE INDEX "MediaUpload_expiresAt_idx" ON "MediaUpload"("expiresAt");

ALTER TABLE "MediaUpload" ADD CONSTRAINT "MediaUpload_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
