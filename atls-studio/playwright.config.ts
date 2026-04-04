import { defineConfig, devices } from "@playwright/test";

/**
 * E2E smoke: starts Vite automatically in CI via webServer; locally you can
 * `npm run dev` separately and set reuseExistingServer (non-CI) to reuse it.
 */
export default defineConfig({
  testDir: "./e2e",
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  webServer: {
    command: "npm run dev",
    // Match Vite's printed Local URL (localhost) so the readiness probe resolves reliably on Windows.
    url: "http://localhost:1420",
    reuseExistingServer: !process.env.CI,
    timeout: 180_000,
  },
  use: {
    baseURL: "http://localhost:1420",
    trace: "on-first-retry",
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
});
