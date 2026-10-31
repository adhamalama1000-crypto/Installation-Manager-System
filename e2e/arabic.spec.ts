import { expect, test, type Page } from "@playwright/test";
import { PASSWORD } from "./helpers";

// No language cookie: the app must open in Arabic, right to left.
test.use({ storageState: { cookies: [], origins: [] } });

/** Signs in with Arabic chosen in the browser (so a saved English preference does not apply). */
async function loginArabic(page: Page, email: string) {
  await page.context().addCookies([{ name: "ims_locale", value: "ar", url: process.env.E2E_BASE_URL ?? "http://localhost:3000" }]);
  await page.goto("/login");
  await page.locator('input[type="email"]').fill(email);
  await page.locator('input[autocomplete="current-password"]').fill(PASSWORD);
  await page.getByRole("button", { name: "تسجيل الدخول" }).click();
  await page.waitForURL((u) => !u.pathname.startsWith("/login"));
}

test("opens in Arabic, right to left, and switches to English and back", async ({ page }) => {
  await page.goto("/login");
  await expect(page.locator("html")).toHaveAttribute("lang", "ar");
  await expect(page.locator("html")).toHaveAttribute("dir", "rtl");
  await expect(page.getByRole("heading", { name: "أهلًا بعودتك" })).toBeVisible();

  await loginArabic(page, "admin@example.com");
  await expect(page.getByRole("link", { name: "لوحة التحكم" }).first()).toBeVisible();
  // The sidebar sits on the right in Arabic.
  const sidebar = page.locator("aside").first();
  const box = await sidebar.boundingBox();
  const width = page.viewportSize()!.width;
  expect(box && box.x + box.width).toBeGreaterThan(width - 5);

  // Switch to English: the page reloads left to right and the choice is remembered.
  await page.getByRole("radio", { name: "English" }).first().click();
  await expect(page.locator("html")).toHaveAttribute("dir", "ltr");
  await expect(page.getByRole("link", { name: "Dashboard" }).first()).toBeVisible();
  await page.goto("/calendar");
  await expect(page.locator("html")).toHaveAttribute("lang", "en");

  await page.getByRole("radio", { name: "العربية" }).first().click();
  await expect(page.locator("html")).toHaveAttribute("dir", "rtl");
  await expect(page.getByRole("heading", { name: "التقويم" })).toBeVisible();
});

test("Arabic pages show Arabic statuses, dates and validation messages", async ({ page }) => {
  await loginArabic(page, "admin@example.com");
  await page.goto("/appointments");
  await expect(page.getByRole("heading", { name: "المواعيد" })).toBeVisible();
  // Default statuses carry Arabic names from the localization migration.
  await expect(page.getByLabel("الحالة").locator("option", { hasText: "مجدول" })).toHaveCount(1);

  await page.goto("/appointments/new");
  await page.getByRole("button", { name: "إنشاء الموعد" }).click();
  await expect(page.getByText("اسم العميل مطلوب")).toBeVisible();
});

test.describe("phone", () => {
  test.use({ viewport: { width: 390, height: 844 } });

  test("Arabic pages fit a phone screen without horizontal scrolling", async ({ page }) => {
    await loginArabic(page, "admin@example.com");
    for (const path of ["/", "/calendar", "/appointments", "/appointments/new", "/customers", "/reports", "/finance", "/leaves", "/inventory", "/day-plan", "/users", "/settings", "/audit", "/profile"]) {
      await page.goto(path);
      await page.waitForLoadState("networkidle");
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
      expect(overflow, `horizontal overflow on ${path}`).toBeLessThanOrEqual(1);
    }
  });

  test("the Arabic navigation drawer opens from the right", async ({ page }) => {
    await loginArabic(page, "sara.sales@example.com");
    await page.getByRole("button", { name: "فتح القائمة" }).click();
    const drawer = page.getByRole("dialog", { name: "القائمة" });
    const box = await drawer.locator("aside").boundingBox();
    expect(box && box.x + box.width).toBeGreaterThan(385);
    await drawer.getByRole("link", { name: "التقويم" }).click();
    await expect(page).toHaveURL(/\/calendar/);
  });
});
