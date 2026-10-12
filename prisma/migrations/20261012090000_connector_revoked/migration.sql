-- A connection the person has revoked: kept so the installations and indexed
-- folders that refer to it still resolve, but no longer listed.
ALTER TYPE "AccountStatus" ADD VALUE 'REVOKED';
