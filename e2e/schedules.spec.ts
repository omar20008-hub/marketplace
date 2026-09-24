import { expect, test } from "@playwright/test";
import { ACCOUNTS, failOnPageProblems, signIn } from "./helpers";

/**
 * Making, pausing, running and deleting a schedule.
 *
 * The middle test is the regression guard. React puts a form back to its
 * defaults once its action resolves, which left the DOM disagreeing with the
 * React state the fields were drawn from: the screen still said "every
 * Wednesday" while the next submit sent "every hour", and the schedule that got
 * saved was not the one on screen. No unit test could see it — the action
 * received exactly what the browser sent.
 */

const rows = (page: import("@playwright/test").Page) => page.locator("tbody tr");

async function openSchedules(page: import("@playwright/test").Page) {
  await page.goto("/results?view=schedules");
  await expect(page.getByRole("button", { name: "New schedule" })).toBeVisible();
}

test("the seeded schedules show when they next run", async ({ page }) => {
  const assertNoProblems = failOnPageProblems(page);

  await signIn(page, ACCOUNTS.nora.email);
  await openSchedules(page);

  expect(await rows(page).count()).toBeGreaterThan(0);
  // Times are UTC, and the labels say so rather than implying local time.
  await expect(rows(page).first()).toContainText("UTC");

  assertNoProblems();
});

test("a blocked submit does not change what the form will save", async ({ page }) => {
  await signIn(page, ACCOUNTS.nora.email);
  await openSchedules(page);

  await page.getByRole("button", { name: "New schedule" }).click();
  await page.selectOption('select[name="cadence"]', "weekly");
  await page.selectOption('select[name="weekday"]', "3");
  await page.fill('input[name="time"]', "14:45");

  // A space satisfies the browser's `required`, so this reaches the server,
  // which trims it and refuses. That is the path that matters: the action
  // resolves, and React resets the form underneath the state it is drawn from.
  const args = page.locator('input[name^="arg."]');
  const required = page.locator('input[name^="arg."][required]');
  for (let i = 0; i < (await required.count()); i++) {
    await required.nth(i).fill(" ");
  }

  const before = await rows(page).count();
  await page.getByRole("button", { name: "Create schedule" }).click();
  await expect(page.locator(".text-danger-ink")).toBeVisible();

  expect(await rows(page).count(), "nothing should have been saved").toBe(before);
  expect(await page.inputValue('select[name="cadence"]')).toBe("weekly");
  expect(await page.inputValue('select[name="weekday"]')).toBe("3");
  expect(await page.inputValue('input[name="time"]')).toBe("14:45");

  // Fill it in and submit again: what is saved must match what is on screen.
  for (let i = 0; i < (await args.count()); i++) {
    await args.nth(i).fill(`e2e-${i}`);
  }
  await page.getByRole("button", { name: "Create schedule" }).click();
  await expect(rows(page)).toHaveCount(before + 1);

  const created = rows(page).last();
  await expect(created).toContainText("Every Wednesday 14:45 UTC");

  await created.getByRole("button", { name: /^Delete/ }).click();
  await expect(rows(page)).toHaveCount(before);
});

test("a schedule can be paused, resumed, run early and deleted", async ({ page }) => {
  await signIn(page, ACCOUNTS.nora.email);
  await openSchedules(page);

  const before = await rows(page).count();

  await page.getByRole("button", { name: "New schedule" }).click();
  await page.selectOption('select[name="cadence"]', "daily");
  await page.fill('input[name="time"]', "06:30");
  const args = page.locator('input[name^="arg."]');
  for (let i = 0; i < (await args.count()); i++) {
    await args.nth(i).fill(`e2e-${i}`);
  }
  await page.getByRole("button", { name: "Create schedule" }).click();
  await expect(rows(page)).toHaveCount(before + 1);

  const row = rows(page).last();
  await expect(row).toContainText("Every day 06:30 UTC");
  await expect(row).toContainText("Not yet run");

  // Pausing clears the next run, so resuming cannot fire for a missed window.
  await row.getByRole("button", { name: "Pause" }).click();
  await expect(row).toContainText("Paused");

  await row.getByRole("button", { name: "Resume" }).click();
  await expect(row).toContainText("On");

  // Running early records a result without moving the next scheduled time.
  await row.getByRole("button", { name: /^Run / }).click();
  await expect(row).toContainText("Succeeded");
  await expect(row).toContainText("Every day 06:30 UTC");

  await row.getByRole("button", { name: /^Delete/ }).click();
  await expect(rows(page)).toHaveCount(before);
});
