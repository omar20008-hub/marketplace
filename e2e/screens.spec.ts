import { expect, test } from "@playwright/test";
import { ACCOUNTS, failOnPageProblems, signIn, signOut } from "./helpers";

/**
 * Every screen, with real data behind it, and nothing broken in the console.
 *
 * Deliberately shallow and wide: it is the sweep that says the app is standing
 * up. The flows that matter get their own files.
 */

test.describe("signed in as a user and admin", () => {
  test("every screen renders with its own heading", async ({ page }) => {
    // Seeded results describe runs from before this instance existed, so their
    // files are honestly missing. That 404 is the intended behaviour.
    const assertNoProblems = failOnPageProblems(page, {
      allow: [/\/api\/artifacts\//],
    });

    await signIn(page, ACCOUNTS.nora.email);

    await page.goto("/");
    await expect(page.locator("h1")).toContainText("What do you want to get done?");

    await page.goto("/marketplace");
    await expect(page).toHaveTitle(/Marketplace/);
    const cards = page.locator('a[href^="/marketplace/"]');
    expect(await cards.count()).toBeGreaterThan(0);

    const slug = await cards.first().getAttribute("href");
    await page.goto(slug!);
    await expect(page.locator("h1")).not.toBeEmpty();

    await page.goto(`${slug}/setup`);
    await expect(page.locator("h1")).toContainText("Activate");

    await page.goto("/workspace");
    await expect(page.locator("h1")).toContainText("My workspace");

    await page.goto("/results");
    await expect(page.locator("h1")).toContainText("Results");

    await page.goto("/accounts");
    await expect(page.locator("h1")).toContainText("Connected accounts");

    await page.goto("/admin");
    await expect(page.locator("h1")).toContainText("Admin");

    assertNoProblems();
  });

  test("a task thread opens from the workspace", async ({ page }) => {
    await signIn(page, ACCOUNTS.nora.email);
    await page.goto("/workspace");

    const thread = page.locator('a[href^="/tasks/"]').first();
    await expect(thread).toBeVisible();
    await thread.click();

    await expect(page).toHaveURL(/\/tasks\//);
    await expect(page.locator("h1")).not.toBeEmpty();
  });
});

test.describe("signed in as a creator", () => {
  test("the studio and the upload form render", async ({ page }) => {
    const assertNoProblems = failOnPageProblems(page);

    await signIn(page, ACCOUNTS.nora.email);
    await signOut(page);
    await signIn(page, ACCOUNTS.rami.email);

    await page.goto("/creator");
    await expect(page.locator("h1")).toContainText("Creator studio");

    await page.goto("/creator/upload");
    await expect(page.locator("h1")).toContainText("Upload a product");

    assertNoProblems();
  });
});

test.describe("before signing in", () => {
  test("every screen redirects to the sign-in page", async ({ page }) => {
    for (const path of ["/", "/workspace", "/results", "/accounts", "/admin"]) {
      await page.goto(path);
      await expect(page, `${path} should require signing in`).toHaveURL(/\/login/);
    }
  });
});
