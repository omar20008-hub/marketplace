-- The "platform" storage backend is not demo data: it is the one destination that
-- needs no external account and every install has to be able to choose. It was
-- only ever created by prisma/seed.ts, which db:seed refuses to run against
-- production (see README "Deploying") — so every real deployment came up with
-- zero rows in StorageAdapter at all, and activation failed for every product
-- with "Storage destination 'platform' is not enabled yet." This runs on every
-- `prisma migrate deploy`, in every environment, so the row always exists.
INSERT INTO "StorageAdapter" ("backend", "displayName", "adapterWorkflowId", "active")
VALUES ('platform', 'Platform storage', 'builtin', true)
ON CONFLICT ("backend") DO NOTHING;
