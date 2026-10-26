import { expect, test } from "@playwright/test";
import { PASSWORD } from "./helpers";

/** Arabic interface: right-to-left layout, the language switch and its persistence. */
test.describe("Arabic interface", () => {
  test.use({ locale: "ar-EG", extraHTTPHeaders: { "Accept-Language": "ar-EG,ar;q=0.9" } });

  test("a browser set to Arabic gets a right-to-left sign-in page", async ({ page }) => {
    await page.goto("/login");
    await expect(page.locator("html")).toHaveAttribute("lang", "ar");
    await expect(page.locator("html")).toHaveAttribute("dir", "rtl");
    await expect(page.getByRole("button", { name: "تسجيل الدخول" })).toBeVisible();
  });

  test("switching language happens in place, keeps what was typed and survives a reload", async ({ page }) => {
    await page.goto("/login");
    await page.getByLabel("البريد الإلكتروني").fill("admin@example.com");
    await page.getByRole("radio", { name: "English" }).click();
    await expect(page.locator("html")).toHaveAttribute("dir", "ltr");
    await expect(page.getByRole("button", { name: "Sign in" })).toBeVisible();
    await expect(page.getByLabel("Email")).toHaveValue("admin@example.com");
    await page.reload();
    await expect(page.locator("html")).toHaveAttribute("lang", "en");
    await expect(page.getByRole("button", { name: "Sign in" })).toBeVisible();
  });

  test("choosing Arabic after signing in applies to every page, right-to-left and fitting a phone", async ({ page }) => {
    await page.goto("/login");
    await page.getByLabel(/^(Email|البريد الإلكتروني)$/).fill("admin@example.com");
    await page.getByLabel(/^(Password|كلمة المرور)$/).fill(PASSWORD);
    await page.getByRole("button", { name: /^(Sign in|تسجيل الدخول)$/ }).click();
    await page.waitForURL((u) => !u.pathname.startsWith("/login"));
    // The account may have English saved; switching in the app saves Arabic on the account.
    await page.getByRole("radio", { name: "العربية" }).filter({ visible: true }).first().click();
    await expect(page.locator("html")).toHaveAttribute("dir", "rtl");
    await page.setViewportSize({ width: 390, height: 844 });
    try {
      for (const path of ["/", "/calendar", "/appointments", "/appointments/new", "/customers", "/reports", "/finance", "/leaves", "/inventory", "/day-plan", "/users", "/settings", "/audit", "/profile"]) {
        await page.goto(path);
        await page.waitForLoadState("networkidle");
        await expect(page.locator("html"), path).toHaveAttribute("dir", "rtl");
        const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
        expect(overflow, `horizontal overflow on ${path}`).toBeLessThanOrEqual(1);
      }
      // Codes and phone numbers stay left-to-right inside Arabic text.
      await page.goto("/appointments");
      await expect(page.locator("bdi[dir=ltr]").first()).toBeVisible();
    } finally {
      // The other specs sign in as the same Admin and read English.
      await page.request.post("/api/locale", { data: { locale: "en" } });
    }
  });
});
