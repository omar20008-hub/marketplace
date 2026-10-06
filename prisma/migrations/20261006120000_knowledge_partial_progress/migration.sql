-- Resumable indexing: where a rate-limited pass stopped. Additive and nullable.
ALTER TABLE "KnowledgeFile" ADD COLUMN "partialRevision" TEXT;
