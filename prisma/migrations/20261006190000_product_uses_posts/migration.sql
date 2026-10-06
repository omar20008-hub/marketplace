-- Additive: marks a template that queues social posts (Post scheduler).
ALTER TABLE "Product" ADD COLUMN "usesPosts" BOOLEAN NOT NULL DEFAULT false;
