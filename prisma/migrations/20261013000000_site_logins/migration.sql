-- Saved website logins and their one-time link requests. Additive: two new tables.

-- CreateTable
CREATE TABLE "SiteLogin" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "siteUrl" TEXT NOT NULL,
    "host" TEXT NOT NULL,
    "username" TEXT NOT NULL,
    "sealedSecret" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "lastUsedAt" TIMESTAMP(3),

    CONSTRAINT "SiteLogin_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SiteLoginRequest" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "siteUrl" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "usedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SiteLoginRequest_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "SiteLogin_userId_idx" ON "SiteLogin"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "SiteLogin_userId_host_username_key" ON "SiteLogin"("userId", "host", "username");

-- CreateIndex
CREATE UNIQUE INDEX "SiteLoginRequest_tokenHash_key" ON "SiteLoginRequest"("tokenHash");

-- CreateIndex
CREATE INDEX "SiteLoginRequest_userId_idx" ON "SiteLoginRequest"("userId");

-- AddForeignKey
ALTER TABLE "SiteLogin" ADD CONSTRAINT "SiteLogin_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SiteLoginRequest" ADD CONSTRAINT "SiteLoginRequest_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- CreateTable
CREATE TABLE "AgentKey" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "keyHash" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "revokedAt" TIMESTAMP(3),

    CONSTRAINT "AgentKey_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "AgentKey_keyHash_key" ON "AgentKey"("keyHash");

-- CreateIndex
CREATE INDEX "AgentKey_userId_idx" ON "AgentKey"("userId");

-- AddForeignKey
ALTER TABLE "AgentKey" ADD CONSTRAINT "AgentKey_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
