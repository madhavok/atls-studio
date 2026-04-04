import { defineConfig, devices } from "@playwright/test";

/**
 * Minimal Playwright config for smoke checks against the Vite dev server.
 * Run: npm run dev (separate terminal) then npx playwright test
 */
export default defineConfig({
  testDir: "./e2e",
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  use: {
    baseURL: "http://127.0.0.1:1420",
    trace: "on-first-retry",
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
});
