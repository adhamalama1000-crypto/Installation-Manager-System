import { defineConfig, devices } from "@playwright/test";

/**
 * End-to-end tests drive the real UI against a running app whose database was seeded with
 * `npm run db:seed` (they create their own appointments in 2031 so they never clash with seed
 * data). Start the app first (`npm run build && npm start`) or let Playwright start it.
 */
export default defineConfig({
  testDir: "./e2e",
  fullyParallel: false,
  workers: 1,
  timeout: 90_000,
  expect: { timeout: 15_000 },
  reporter: [["list"]],
  use: {
    baseURL: process.env.E2E_BASE_URL ?? "http://localhost:3000",
    trace: "retain-on-failure",
    ...devices["Desktop Chrome"],
    // The specs read English text. Without a locale the browser sends no Accept-Language and the
    // app uses its default language (Arabic); Arabic pages are covered by their own spec.
    locale: "en-US",
    extraHTTPHeaders: { "Accept-Language": "en-US,en;q=0.9" },
    launchOptions: process.env.PLAYWRIGHT_CHROMIUM_PATH ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_PATH } : {},
  },
  webServer: process.env.E2E_BASE_URL
    ? undefined
    : { command: "npm run start", url: "http://localhost:3000/login", reuseExistingServer: true, timeout: 180_000 },
});
