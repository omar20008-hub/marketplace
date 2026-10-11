-- ConnectedAccount becomes Connector. Renamed in place rather than dropped and
-- recreated, so every stored connection and the links to it survive.

ALTER TABLE "ConnectedAccount" RENAME TO "Connector";

ALTER TABLE "Connector" RENAME CONSTRAINT "ConnectedAccount_pkey" TO "Connector_pkey";
ALTER TABLE "Connector" RENAME CONSTRAINT "ConnectedAccount_userId_fkey" TO "Connector_userId_fkey";
ALTER INDEX "ConnectedAccount_userId_credentialType_accountRef_key" RENAME TO "Connector_userId_credentialType_accountRef_key";

ALTER TABLE "InstallationCredential" RENAME COLUMN "accountId" TO "connectorId";
ALTER TABLE "InstallationCredential" RENAME CONSTRAINT "InstallationCredential_accountId_fkey" TO "InstallationCredential_connectorId_fkey";

ALTER TABLE "KnowledgeSource" RENAME COLUMN "accountId" TO "connectorId";
ALTER INDEX "KnowledgeSource_accountId_idx" RENAME TO "KnowledgeSource_connectorId_idx";
ALTER TABLE "KnowledgeSource" RENAME CONSTRAINT "KnowledgeSource_accountId_fkey" TO "KnowledgeSource_connectorId_fkey";
