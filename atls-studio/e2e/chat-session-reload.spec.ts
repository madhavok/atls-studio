import { test, expect } from "@playwright/test";

/**
 * Playwright runs against Vite in the browser; chat SQLite is only available in the Tauri
 * desktop shell. Session/message persistence is covered in Vitest (`chatDb`, persistence
 * hooks) and in Rust (`chat_db`). This spec ensures a full reload does not break the app shell (regression guard for desktop webviews too).
 */
test("app shell survives reload (sessionStorage + layout)", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByTestId("app-root")).toBeVisible();

  await page.evaluate(() => sessionStorage.setItem("atls-e2e-reload-check", "ok"));
  await page.reload();
  expect(await page.evaluate(() => sessionStorage.getItem("atls-e2e-reload-check"))).toBe("ok");

  await expect(page.getByTestId("app-root")).toBeVisible();
  await expect(page.getByTestId("main-layout")).toBeVisible();
});
