import { expect, test } from "@playwright/test";
import { ACCOUNTS, failOnPageProblems, signIn } from "./helpers";

/**
 * Searching the task list, and the controls that are deliberately absent.
 *
 * The second test is the guard against a dead affordance coming back. The
 * design draws an attach button, a dictate button and a "Try with sample data"
 * button; none has a contract behind it, and each was removed rather than left
 * to do nothing when clicked. If one returns without the feature, this fails.
 */

test("the task list can be searched", async ({ page }) => {
  const assertNoProblems = failOnPageProblems(page);

  await signIn(page, ACCOUNTS.nora.email);
  await page.goto("/workspace");

  const threads = page.locator('a[href^="/tasks/"]');
  const all = await threads.count();
  expect(all, "the seed should leave some tasks to search").toBeGreaterThan(1);

  const first = await threads.first().innerText();
  const word = first.split(/\s+/).find((part) => part.length > 3)!;

  await page.getByRole("button", { name: "Search tasks" }).click();
  const box = page.getByRole("searchbox", { name: "Search tasks" });
  await expect(box).toBeFocused();

  await box.fill(word);
  await expect(threads).not.toHaveCount(all);
  expect(await threads.count()).toBeGreaterThan(0);
  await expect(threads.first()).toContainText(word);

  // Something nothing can match.
  await box.fill("zzzzzzzz-no-such-task");
  await expect(threads).toHaveCount(0);
  await expect(page.getByText(/No task matches/)).toBeVisible();

  // Escape closes the search and puts every task back.
  await box.press("Escape");
  await expect(box).toBeHidden();
  await expect(threads).toHaveCount(all);

  assertNoProblems();
});

test("search is case-insensitive", async ({ page }) => {
  await signIn(page, ACCOUNTS.nora.email);
  await page.goto("/workspace");

  const threads = page.locator('a[href^="/tasks/"]');
  const word = (await threads.first().innerText()).split(/\s+/).find((p) => p.length > 3)!;

  await page.getByRole("button", { name: "Search tasks" }).click();
  const box = page.getByRole("searchbox", { name: "Search tasks" });

  await box.fill(word.toUpperCase());
  const upper = await threads.count();
  await box.fill(word.toLowerCase());

  expect(await threads.count()).toBe(upper);
  expect(upper).toBeGreaterThan(0);
});

test("no control is on screen that does nothing when clicked", async ({ page }) => {
  await signIn(page, ACCOUNTS.nora.email);

  await page.goto("/");
  await expect(page.getByRole("button", { name: "Attach" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Dictate" })).toHaveCount(0);

  await page.goto("/marketplace");
  const slug = await page.locator('a[href^="/marketplace/"]').first().getAttribute("href");
  await page.goto(slug!);
  await expect(page.getByText("Try with sample data")).toHaveCount(0);

  // What that button was there to answer is on the page already.
  await expect(page.getByText("Inputs", { exact: true })).toBeVisible();
  await expect(page.getByText("Outputs", { exact: true })).toBeVisible();
});
