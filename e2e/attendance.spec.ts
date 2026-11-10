import { expect, test } from "@playwright/test";
import { login } from "./helpers";

/**
 * Clock-in with a live camera photo and the phone's location, through the real UI. Chromium's fake
 * camera stands in for the phone camera, and the location is simulated. Then the Admin sees the
 * day on the attendance page with the photo. Uses Youssef (a seeded technician) so other specs'
 * check-ins of Karim do not interfere; on a database where he already clocked in today the
 * page shows his clock-out instead, which the test accepts.
 */
test.use({
  launchOptions: { args: ["--use-fake-device-for-media-stream", "--use-fake-ui-for-media-stream"] },
  permissions: ["camera", "geolocation"],
  geolocation: { latitude: 30.0444, longitude: 31.2357, accuracy: 15 },
});

test("a technician clocks in with a live photo and the Admin sees it on the attendance page", async ({ page, browser }) => {
  await login(page, "youssef.tech@example.com");
  await page.goto("/attendance/clock");
  await expect(page.getByRole("heading", { level: 1, name: "Clock in / out" })).toBeVisible();
  const button = page.getByRole("button", { name: /^(Clock in|Clock out)$/ });
  if (await button.count()) {
    // The photo comes from the camera stream; the location's accuracy is shown before sending.
    await expect(page.getByText("Accuracy ±15 m")).toBeVisible();
    await page.getByRole("button", { name: "Take photo" }).click();
    await expect(page.getByRole("img", { name: "Your photo" })).toBeVisible();
    await button.click();
    await expect(page.getByText(/Clocked in at \d{2}:\d{2}/)).toBeVisible();
  }
  await expect(page.getByText(/Clocked in at \d{2}:\d{2}/)).toBeVisible();

  const admin = await (await browser.newContext()).newPage();
  await login(admin, "admin@example.com");
  await admin.goto("/attendance/daily");
  const row = admin.locator("tbody tr").filter({ hasText: "Youssef" });
  await expect(row).toContainText("Present");
  await expect(row.getByRole("img", { name: /Photo/ }).first()).toBeVisible();
  // The photo is served only through the permission-checked route.
  const src = await row.getByRole("img", { name: /Photo/ }).first().getAttribute("src");
  expect(src).toMatch(/^\/api\/attendance\/selfie\//);
  const anonymous = await (await browser.newContext()).request.get(src!);
  expect(anonymous.status()).toBe(401);
});
