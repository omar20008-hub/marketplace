import { expect, test, type Page } from "@playwright/test";
import { ACCOUNTS, failOnPageProblems, signIn } from "./helpers";

/**
 * Starting a run from My workspace, and getting the file it produced.
 *
 * The second test here is a regression guard. The Open and Download buttons
 * used to be next/link, which prefetches on hover — so merely passing the
 * pointer over a result fetched the whole file, threw the bytes away, and
 * fetched them again on the click. Nothing about the page looked wrong; the
 * only visible trace was a 404 in the console for a file nobody had asked for.
 */

/**
 * Starts a run the way a person does once a product is installed: the Run button
 * on its card in My workspace. (The home composer no longer runs anything itself —
 * it asks the orchestrator, whose reply is conversation, not a file.)
 */
async function startRunFromWorkspace(page: Page) {
  await page.goto("/workspace");
  await Promise.all([
    page.waitForURL(/\/tasks\//),
    page.locator('form:has(input[name="installationId"]) button[type="submit"]:has-text("Run")').first().click(),
  ]);

  // Most products ask for something first. Whatever it is, any answer runs it —
  // what is being tested is the file that comes out, not the input.
  const needsDetails = page.locator('button:has-text("Run with these")');
  if (await needsDetails.isVisible()) {
    for (const field of await page.locator('main input[type="text"], main textarea:not([disabled])').all()) {
      if (await field.isEditable()) await field.fill("test");
    }
    await needsDetails.click();
  }
}

test("a task runs and produces a file that opens", async ({ page }) => {
  const assertNoProblems = failOnPageProblems(page, {
    allow: [/\/api\/artifacts\//],
  });

  await signIn(page, ACCOUNTS.nora.email);

  await startRunFromWorkspace(page);

  const open = page.locator('a[href^="/api/artifacts/"]').first();
  await expect(open).toBeVisible();

  // The run just produced this, so unlike the seeded ones it has real bytes.
  const href = await open.getAttribute("href");
  const response = await page.request.get(href!);
  expect(response.status()).toBe(200);
  expect((await response.body()).length).toBeGreaterThan(0);

  assertNoProblems();
});

test("result links are plain anchors, so hovering one downloads nothing", async ({
  page,
}) => {
  await signIn(page, ACCOUNTS.nora.email);

  await startRunFromWorkspace(page);

  const links = page.locator('a[href^="/api/artifacts/"]');
  await expect(links.first()).toBeVisible();

  const artifactRequests: string[] = [];
  page.on("request", (request) => {
    if (request.url().includes("/api/artifacts/")) artifactRequests.push(request.url());
  });

  await links.first().hover();
  await page.waitForTimeout(1000);

  expect(artifactRequests, "hovering must not fetch the file").toEqual([]);

  // The download button saves under the artifact's own name.
  const download = page.locator('a[href*="download=1"]').first();
  await expect(download).toHaveAttribute("download", /.+/);
});
