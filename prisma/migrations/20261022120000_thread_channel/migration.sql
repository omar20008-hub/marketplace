-- The thread that holds a chat channel's conversation (WhatsApp), so every
-- channel's conversation is kept in the platform.

-- AlterTable
ALTER TABLE "Thread" ADD COLUMN "channel" TEXT;

-- CreateIndex
CREATE INDEX "Thread_userId_channel_idx" ON "Thread"("userId", "channel");
