-- Chat channel links (Telegram). Additive: two new tables, no change to existing ones.

-- CreateTable
CREATE TABLE "ChannelLink" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "channel" TEXT NOT NULL,
    "externalId" TEXT NOT NULL,
    "linkedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ChannelLink_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ChannelLinkCode" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "channel" TEXT NOT NULL,
    "codeHash" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "usedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ChannelLinkCode_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ChannelLink_channel_externalId_key" ON "ChannelLink"("channel", "externalId");

-- CreateIndex
CREATE UNIQUE INDEX "ChannelLink_userId_channel_key" ON "ChannelLink"("userId", "channel");

-- CreateIndex
CREATE UNIQUE INDEX "ChannelLinkCode_codeHash_key" ON "ChannelLinkCode"("codeHash");

-- CreateIndex
CREATE INDEX "ChannelLinkCode_userId_channel_idx" ON "ChannelLinkCode"("userId", "channel");

-- AddForeignKey
ALTER TABLE "ChannelLink" ADD CONSTRAINT "ChannelLink_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ChannelLinkCode" ADD CONSTRAINT "ChannelLinkCode_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

