import { expect, type Page } from "@playwright/test";

/** The seeded accounts. Both use the password below. */
export const ACCOUNTS = {
  nora: { email: "nora@acme.co", roles: "user + admin" },
  rami: { email: "rami@studio.co", roles: "creator" },
} as const;

export const PASSWORD = "builder";

export async function signIn(page: Page, email: string) {
  await page.goto("/login");
  await page.fill('input[type="email"]', email);
  await page.fill('input[type="password"]', PASSWORD);
  await Promise.all([
    page.waitForURL((url) => !url.pathname.startsWith("/login")),
    // The sidebar's sign-out is also a submit button, so this has to name the
    // one inside the form.
    page.click('form button[type="submit"]:has-text("Sign in")'),
  ]);
}

export async function signOut(page: Page) {
  await Promise.all([
    page.waitForURL(/\/login/),
    page.click('button[aria-label="Sign out"]'),
  ]);
}

/**
 * Fails the test on any console error, uncaught exception or 4xx/5xx response.
 *
 * This is what caught the prefetching download links: nothing on the page
 * looked wrong, but every result was quietly fetching a file nobody had asked
 * for and logging a 404 for it.
 */
export function failOnPageProblems(page: Page, { allow = [] as RegExp[] } = {}) {
  const problems: string[] = [];

  page.on("pageerror", (error) => problems.push(`uncaught: ${error.message}`));
  page.on("console", (message) => {
    if (message.type() === "error") problems.push(`console: ${message.text()}`);
  });
  page.on("response", (response) => {
    const url = response.url();
    if (response.status() >= 400 && !allow.some((pattern) => pattern.test(url))) {
      problems.push(`HTTP ${response.status()} ${url}`);
    }
  });

  return () => expect(problems, problems.join("\n")).toEqual([]);
}
