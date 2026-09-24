/**
 * Where the tests' own database lives.
 *
 * The suite needs a database of its own: the tests that exercise the server
 * actions clear their tables between cases, and pointing them at the
 * development database would wipe the seeded catalogue someone is looking at.
 *
 * It is derived from DATABASE_URL by appending "_test" so there is no second
 * connection string to keep in step — move the development database and the
 * test one follows. TEST_DATABASE_URL overrides it outright, for CI that hands
 * the job a database directly.
 *
 * Both the setup script and the test run read this, so the two can never
 * disagree about which database is about to be cleared.
 */
export function testDatabaseUrl(): string {
  if (process.env.TEST_DATABASE_URL) return process.env.TEST_DATABASE_URL;

  const base = process.env.DATABASE_URL;
  if (!base) {
    throw new Error(
      "Missing DATABASE_URL. Copy .env.example to .env, or set TEST_DATABASE_URL.",
    );
  }

  const url = new URL(base);
  // pathname is "/builder"; the leading slash is not part of the name.
  url.pathname = `/${decodeURIComponent(url.pathname.slice(1))}_test`;
  return url.toString();
}
