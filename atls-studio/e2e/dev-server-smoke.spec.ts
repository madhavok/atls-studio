import { test, expect } from "@playwright/test";

/**
 * Requires the Vite dev server on port 1420 (npm run dev).
 * Validates that the SPA shell loads without a blank document.
 */
test("dev server root responds with HTML", async ({ page }) => {
  const res = await page.goto("/");
  expect(res?.ok()).toBeTruthy();
  await expect(page.locator("body")).toBeVisible();
});
