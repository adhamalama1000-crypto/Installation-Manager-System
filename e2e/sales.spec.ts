import { expect, test } from "@playwright/test";
import { login } from "./helpers";

/**
 * A salesperson sells from the main store through the real UI: the price comes from the catalogue,
 * totals update as they type, confirming issues the stock; the Admin then sees it in the
 * analytics, which count confirmed sales only. Uses the seeded Cat6 cable (400 m in MAIN at 20 EGP/m),
 * so the test can run many times against the same database.
 */
const run = Date.now().toString(36).toUpperCase().slice(-6);

test("Sales confirms a sale and it appears in the analytics", async ({ page, browser }) => {
  await login(page, "sara.sales@example.com");
  await page.goto("/sales/new");
  await expect(page.getByRole("heading", { level: 1, name: "New sale" })).toBeVisible();
  await page.getByLabel("Walk-in customer name").fill(`Walk-in ${run}`);
  await page.getByLabel("Sold from warehouse").selectOption({ label: "MAIN · Main store" });
  await page.getByRole("textbox", { name: "Item 1" }).fill("CBL-CAT6");
  await page.getByRole("listbox", { name: "Item 1" }).getByRole("button").filter({ hasText: "CBL-CAT6" }).first().click();
  // The selling price is filled in from the product; the total follows the quantity and discount.
  await expect(page.getByLabel("Unit price")).toHaveValue("20");
  await page.getByLabel(/^Quantity/).fill("2.5");
  await page.getByLabel("Discount (amount)").fill("5");
  await expect(page.getByTestId("sale-total")).toContainText("45");

  await page.getByRole("button", { name: "Save and confirm" }).click();
  const dialog = page.getByRole("dialog", { name: "Confirm this sale?" });
  await dialog.getByRole("button", { name: "Confirm sale" }).click();
  await page.waitForURL(/\/sales\/(?!new)[^/]+$/);
  await expect(page.getByRole("heading", { level: 1 })).toContainText("Confirmed");
  await expect(page.getByRole("heading", { level: 1 })).toContainText(/INV-\d{4}-\d{6}/);
  // Sales may not cancel a confirmed sale (that needs sales.void).
  await expect(page.getByRole("button", { name: "Cancel sale" })).toHaveCount(0);

  const admin = await (await browser.newContext()).newPage();
  await login(admin, "admin@example.com");
  await admin.goto("/analytics");
  await expect(admin.getByRole("heading", { level: 1, name: "Sales analytics" })).toBeVisible();
  await expect(admin.getByText("From confirmed sales invoices only.", { exact: false })).toBeVisible();
  // The card whose heading is "Best-selling products" lists the cable.
  const best = admin.getByRole("heading", { name: "Best-selling products" }).locator("xpath=ancestor::div[.//table][1]");
  await expect(best.getByRole("link", { name: "CBL-CAT6" }).first()).toBeVisible();
  // The year-over-year chart offers its numbers as a table too.
  await admin.getByText("Show as a table").first().click();
  await expect(admin.locator("details[open] table").first()).toBeVisible();
});
