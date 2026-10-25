import { expect, test } from "@playwright/test";
import { login } from "./helpers";

test.use({ viewport: { width: 390, height: 844 } });

test("main pages fit a phone screen without horizontal scrolling", async ({ page }) => {
  await login(page, "admin@example.com");
  for (const path of ["/", "/calendar", "/appointments", "/appointments/new", "/customers", "/reports", "/users", "/settings", "/audit", "/profile"]) {
    await page.goto(path);
    await page.waitForLoadState("networkidle");
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    expect(overflow, `horizontal overflow on ${path}`).toBeLessThanOrEqual(1);
  }
});

test("mobile navigation drawer opens and navigates", async ({ page }) => {
  await login(page, "sara.sales@example.com");
  await page.getByRole("button", { name: "Open navigation" }).click();
  await page.getByRole("dialog", { name: "Navigation" }).getByRole("link", { name: "Calendar" }).click();
  await expect(page).toHaveURL(/\/calendar/);
  await expect(page.getByRole("tab", { name: "Agenda" })).toHaveAttribute("aria-selected", "true");
});
