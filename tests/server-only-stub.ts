/**
 * Stands in for the `server-only` package during tests.
 *
 * That package's default export exists only to throw, so that importing a
 * server module from a Client Component fails the build. Next swaps it for an
 * empty module when it resolves server code; vitest.config.mts aliases it here
 * for the same reason. Nothing to export — being importable is the whole job.
 */
export {};
