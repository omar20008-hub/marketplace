import { randomBytes } from "node:crypto";
import { defineConfig, devices } from "@playwright/test";

/**
 * End-to-end tests, in a real browser, against the built app.
 *
 * These exist because of where this codebase's bugs have actually come from.
 * Every one found so far surfaced by driving the app — a download link that
 * fetched the file on hover, a wizard that dropped the inputs it had just
 * collected, a schedule form that saved a different cadence than the one on
 * screen. None of them were visible to a unit test, because each was about how
 * the browser and the framework behave together rather than about a function's
 * return value.
 *
 * They are not part of `npm test`. They need Postgres, a seeded database and a
 * built app, so they get their own command:
 *
 *   npm run build && npm run test:e2e
 *
 * The suite signs in, writes and deletes rows, and expects the seeded
 * catalogue, so point it at a development database — never a real one.
 */

/** Playwright's own default, unless a container already has a browser. */
const executablePath = process.env.PLAYWRIGHT_CHROMIUM_PATH;

/**
 * `npm run start` is a production boot, and lib/env.ts refuses to come up in
 * production on the tokens .env.example ships with — so the server the browser
 * drives has to be given real ones or it answers 500 to everything.
 *
 * Generated per run rather than written down. Nothing in `e2e/` calls the
 * endpoints these protect; they exist here only to get past the guard, and a
 * value that lives for one run cannot be copied into a deployment by mistake.
 *
 * AUTH_SECRET and SECRETS_KEY are deliberately not overridden. The seeded
 * connected-account credentials were sealed with the SECRETS_KEY in .env, and a
 * different one would make them undecryptable — which is the guard's whole
 * point, seen from the other side.
 */
const realEnoughTokens = {
  SCHEDULE_TOKEN: randomBytes(24).toString("base64url"),
  N8N_SYNC_TOKEN: randomBytes(24).toString("base64url"),
};

export default defineConfig({
  testDir: "./e2e",
  // One worker: the tests share one database and one signed-in account, and
  // two of them creating and deleting schedules at once would read each
  // other's rows.
  workers: 1,
  fullyParallel: false,
  forbidOnly: Boolean(process.env.CI),
  retries: 0,
  reporter: process.env.CI ? "list" : [["list"]],

  use: {
    baseURL: process.env.E2E_BASE_URL ?? "http://localhost:3000",
    trace: "retain-on-failure",
    ...devices["Desktop Chrome"],
    ...(executablePath ? { launchOptions: { executablePath } } : {}),
  },

  // Starts the app if it is not already up, and leaves an already-running one
  // alone, so an edit-and-rerun loop does not fight the dev server.
  webServer: process.env.E2E_BASE_URL
    ? undefined
    : {
        command: "npm run start",
        url: "http://localhost:3000/login",
        reuseExistingServer: true,
        timeout: 120_000,
        env: realEnoughTokens,
      },
});
