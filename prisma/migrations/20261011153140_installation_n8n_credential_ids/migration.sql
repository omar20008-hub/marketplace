-- Credential ids of each installed copy, so uninstall can delete them. Additive:
-- one new column with an empty default; existing rows are untouched.

-- AlterTable
ALTER TABLE "Installation" ADD COLUMN "n8nCredentialIds" TEXT[] DEFAULT ARRAY[]::TEXT[];
