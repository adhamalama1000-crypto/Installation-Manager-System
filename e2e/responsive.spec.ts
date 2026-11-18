import { expect, test } from "@playwright/test";
import { login } from "./helpers";

test.use({ viewport: { width: 390, height: 844 } });

test("main pages fit a phone screen without horizontal scrolling", async ({ page }) => {
  await login(page, "admin@example.com");
  for (const path of ["/", "/calendar", "/appointments", "/appointments/new", "/customers", "/reports", "/finance", "/leaves", "/inventory", "/day-plan", "/users", "/settings", "/audit", "/profile",
      "/products", "/products/new", "/products/setup", "/warehouses", "/stock", "/stock/documents", "/stock/documents/new?type=TRANSFER", "/stock/movements", "/stocktakes",
      "/suppliers", "/sales", "/sales/new", "/analytics", "/attendance/daily", "/attendance/clock", "/evidence", "/evidence?status=APPROVED",
      "/penalties", "/penalties?status=", "/penalties/rules", "/penalties/mine"]) {
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

test.describe("tablet landscape (1024 px)", () => {
  test.use({ viewport: { width: 1024, height: 768 } });

  test("filter rows of the product and stock lists fit beside the sidebar", async ({ page }) => {
    await login(page, "admin@example.com");
    for (const path of ["/products", "/stock", "/stock/movements", "/stock/documents"]) {
      await page.goto(path);
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
      expect(overflow, path).toBeLessThanOrEqual(1);
    }
  });
});

test.describe("phone menus", () => {
  test.use({ viewport: { width: 360, height: 780 } });

  test("the New document menu opens fully on screen", async ({ page }) => {
    await login(page, "admin@example.com");
    await page.goto("/stock/documents");
    await page.getByText("New document").click();
    const box = await page.getByRole("link", { name: "Goods receipt" }).boundingBox();
    expect(box).not.toBeNull();
    expect(box!.x).toBeGreaterThanOrEqual(0);
    expect(box!.x + box!.width).toBeLessThanOrEqual(360);
  });
});
