-- Every product is an agent now; the Agent/Workflow split is gone from the product.
-- Data only: the ProductKind enum and the column stay. Idempotent.
UPDATE "Product" SET "kind" = 'AGENT' WHERE "kind" = 'WORKFLOW';
