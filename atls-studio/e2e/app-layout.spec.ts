import { test, expect } from "@playwright/test";

test.describe("app shell", () => {
  test("root landmark is visible", async ({ page }) => {
    await page.goto("/");
    const root = page.getByTestId("app-root");
    await expect(root).toBeVisible();
  });

  test("main three-column layout region is visible", async ({ page }) => {
    await page.goto("/");
    await expect(page.getByTestId("main-layout")).toBeVisible();
  });
});
