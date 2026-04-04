import { test, expect } from "@playwright/test";

/**
 * Smoke: SPA root returns HTML and body is visible.
 * CI: Playwright starts Vite via webServer (see playwright.config.ts).
 * Local: `npm run dev` or rely on webServer when CI is unset.
 */
test("dev server root responds with HTML", async ({ page }) => {
  const res = await page.goto("/");
  expect(res?.ok()).toBeTruthy();
  await expect(page.locator("body")).toBeVisible();
});
