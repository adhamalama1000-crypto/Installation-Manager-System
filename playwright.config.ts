import { defineConfig, devices } from "@playwright/test";

/**
 * End-to-end tests drive the real UI against a running app whose database was seeded with
 * `npm run db:seed` (they create their own appointments in 2031 so they never clash with seed
 * data). Start the app first (`npm run build && npm start`) or let Playwright start it.
 */
const baseURL = process.env.E2E_BASE_URL ?? "http://localhost:3000";

export default defineConfig({
  testDir: "./e2e",
  fullyParallel: false,
  workers: 1,
  timeout: 90_000,
  expect: { timeout: 15_000 },
  reporter: [["list"]],
  use: {
    baseURL,
    // The app opens in Arabic by default; these specs drive the English UI. e2e/arabic.spec.ts
    // clears this cookie to test the default Arabic, right-to-left interface.
    storageState: {
      cookies: [{ name: "ims_locale", value: "en", domain: new URL(baseURL).hostname, path: "/", expires: -1, httpOnly: true, secure: false, sameSite: "Lax" }],
      origins: [],
    },
    trace: "retain-on-failure",
    ...devices["Desktop Chrome"],
    launchOptions: process.env.PLAYWRIGHT_CHROMIUM_PATH ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_PATH } : {},
  },
  webServer: process.env.E2E_BASE_URL
    ? undefined
    : { command: "npm run start", url: "http://localhost:3000/login", reuseExistingServer: true, timeout: 180_000 },
});
