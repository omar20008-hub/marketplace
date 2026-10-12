import { expect, test } from "@playwright/test";
import { failOnPageProblems, signIn, signOut } from "./helpers";

/**
 * Signing in with a real account, from the environment rather than the seed.
 *
 * The credentials come from E2E_EMAIL and E2E_PASSWORD and are never written
 * into this file, a log or a report. If either is unset the whole file is
 * skipped with that reason, so `npm run test:e2e` still passes on a machine
 * that has no account to test with.
 *
 * There is deliberately no wrong-password case. Repeated failed sign-ins lock
 * the address out, and this file would be locking out the account it is
 * supposed to be testing.
 */

const email = process.env.E2E_EMAIL;
const password = process.env.E2E_PASSWORD;

test.describe("signed in with E2E_EMAIL and E2E_PASSWORD", () => {
  test.skip(
    !email || !password,
    "E2E_EMAIL and E2E_PASSWORD must both be set to run the live sign-in tests",
  );

  test("signing in leaves the sign-in page and shows the sign-out control", async ({ page }) => {
    const assertNoProblems = failOnPageProblems(page);

    await signIn(page, email!, password!);

    await expect(page).not.toHaveURL(/\/login/);
    await expect(page.locator('button[aria-label="Sign out"]')).toBeVisible();

    assertNoProblems();
  });

  test("the main signed-in screens load without bouncing to sign-in", async ({ page }) => {
    const assertNoProblems = failOnPageProblems(page, {
      // Seeded results point at files that were never uploaded here.
      allow: [/\/api\/artifacts\//],
    });

    await signIn(page, email!, password!);

    for (const path of ["/", "/marketplace", "/workspace", "/accounts"]) {
      await page.goto(path);
      await expect(page, `${path} should not require signing in again`).not.toHaveURL(/\/login/);
      await expect(page.getByRole("heading").first(), `${path} should have a heading`).not.toBeEmpty();
    }

    assertNoProblems();
  });

  test("signing out ends the session", async ({ page }) => {
    await signIn(page, email!, password!);

    await signOut(page);

    await page.goto("/workspace");
    await expect(page).toHaveURL(/\/login/);
  });
});
