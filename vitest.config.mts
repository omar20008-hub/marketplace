import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";
import tsconfigPaths from "vite-tsconfig-paths";

/**
 * Unit tests for the server half: readiness, the vault, the n8n drivers and the
 * rules the actions enforce. No jsdom and no component rendering — the eleven
 * screens are verified in a browser, which is what Next's own guide recommends
 * for async Server Components.
 *
 * lib/env.ts, lib/secrets.ts and the drivers all start with `import
 * "server-only"`, whose default export exists only to throw. Next resolves that
 * package to an empty module under the `react-server` condition; the alias
 * below is that same resolution. It is pointed straight at the package's own
 * own stub rather than set as a condition because the package is CommonJS and
 * gets externalized, which puts it beyond Vite's condition resolution, and its
 * exports map does not expose the empty module by path.
 */
export default defineConfig({
  plugins: [tsconfigPaths()],
  test: {
    environment: "node",
    include: ["src/**/*.test.ts", "tests/**/*.test.ts"],
    setupFiles: ["tests/setup.ts"],
    /**
     * One file at a time. The tests that exercise the server actions run
     * against a real Postgres and clear their tables between cases, so two of
     * them in parallel delete each other's rows. The whole suite takes a couple
     * of seconds, which is a good trade for never debugging that again.
     */
    fileParallelism: false,
  },
  resolve: {
    alias: {
      "server-only": fileURLToPath(
        new URL("./tests/server-only-stub.ts", import.meta.url),
      ),
    },
  },
});
