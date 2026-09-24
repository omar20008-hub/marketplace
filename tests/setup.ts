/**
 * Runs before every test file, and before any module under test is imported.
 *
 * lib/env.ts builds its `env` object at import time and throws on a missing
 * value, so these have to be in place first.
 *
 * Only the database address comes from .env, because the tests need a real
 * Postgres and that is where its address already is. Every secret below is a
 * fixed test value: reading the developer's own key would make the encryption
 * tests pass or fail depending on whose machine they ran on.
 */

import "dotenv/config";
import { testDatabaseUrl } from "./test-database-url";

// Always a database of its own — see test-database-url.ts. Create it first with
// `npm run test:db:setup`.
process.env.DATABASE_URL = testDatabaseUrl();

process.env.AUTH_SECRET = "test-auth-secret-not-used-for-anything-real";

// 32 bytes as 64 hex characters, which is what SECRETS_KEY must be.
process.env.SECRETS_KEY =
  "00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff";

process.env.N8N_DRIVER = "mock";
process.env.N8N_WEBHOOK_TOKEN = "test-webhook-token";
process.env.N8N_SYNC_TOKEN = "test-sync-token";
