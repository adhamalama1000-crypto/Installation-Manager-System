import { expect, test, type Page } from "@playwright/test";
import { login, PASSWORD } from "./helpers";

/**
 * ERP inventory foundation through the real UI: the catalogue, a goods receipt posted and then
 * reversed, a stocktake approved into an adjustment, and who sees and may do what. Runs against the
 * seeded database (warehouse@example.com, MAIN, VAN-KARIM and the demo products); everything it
 * creates carries a per-run code.
 */
const run = Date.now().toString(36).toUpperCase().slice(-6);

async function pickProduct(page: Page, line: string, search: string) {
  await page.getByRole("textbox", { name: line }).fill(search);
  await page.getByRole("listbox", { name: line }).getByRole("button").filter({ hasText: search }).first().click();
}

test("the warehouse manager adds a product, receives it, and reverses the receipt", async ({ page }) => {
  const sku = `E2E-${run}`;
  await login(page, "warehouse@example.com");
  const nav = page.getByRole("navigation", { name: "Main" });
  await expect(nav.getByText("Inventory", { exact: true })).toBeVisible();
  await expect(nav.getByRole("link", { name: "Stock on hand" })).toBeVisible();

  // A new product, validated on the server (both names are required).
  await page.goto("/products/new");
  await page.getByLabel("SKU").fill(sku.toLowerCase());
  await page.getByLabel("Name (English)").fill(`E2E bracket ${run}`);
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect(page.getByText("Name (Arabic) is required")).toBeVisible();
  await page.getByLabel("Name (Arabic)").fill(`كتيفة ${run}`);
  await page.getByLabel("Unit of measure").selectOption({ label: "Piece (PCS)" });
  await page.getByLabel("Purchase cost (EGP)").fill("150");
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await page.waitForURL(/\/products\/(?!new)[^/]+$/);
  await expect(page.getByRole("heading", { level: 1 })).toContainText(sku);

  // Goods receipt into the main store, posted after a confirmation.
  await page.goto("/stock/documents/new?type=RECEIPT");
  await expect(page.getByRole("heading", { name: "New Goods receipt" })).toBeVisible();
  await page.getByLabel("To warehouse").selectOption({ label: "MAIN · Main store" });
  await page.getByLabel("Reference").fill(`INV-${run}`);
  await pickProduct(page, "Line 1", sku);
  await page.getByLabel(/^Quantity/).fill("5");
  await page.getByRole("button", { name: "Save and post" }).click();
  const confirm = page.getByRole("dialog", { name: "Post this document?" });
  await confirm.getByRole("button", { name: "Post" }).click();
  await page.waitForURL(/\/stock\/documents\/(?!new)[^/]+$/);
  await expect(page.getByRole("heading", { level: 1 })).toContainText("Posted");
  const movements = page.locator("table").last();
  await expect(movements).toContainText("Goods receipt");
  await expect(movements).toContainText("+5");

  await page.goto(`/stock?view=location&q=${sku}`);
  await expect(page.locator("tbody tr")).toHaveCount(1);
  await expect(page.locator("tbody tr").first()).toContainText("MAIN");

  // Cancelling a posted document needs a reason and writes a reversal; nothing is deleted.
  await page.goBack();
  await page.goto(`/stock/documents?q=INV-${run}`);
  await page.getByRole("link", { name: /^GRN-/ }).first().click();
  await page.getByRole("button", { name: "Cancel by reversal" }).click();
  const reverse = page.getByRole("dialog", { name: /Cancel posted document/ });
  await expect(reverse.getByRole("button", { name: "Cancel and reverse" })).toBeDisabled();
  await reverse.getByLabel("Reason").fill("Wrong supplier invoice");
  await reverse.getByRole("button", { name: "Cancel and reverse" }).click();
  await expect(page.getByRole("heading", { level: 1 })).toContainText("Cancelled");
  await expect(page.locator("table").last()).toContainText("Reversal");
  await expect(page.getByText("Reason: Wrong supplier invoice")).toBeVisible();
});

test("a stocktake of a new warehouse is counted, submitted and approved into an adjustment", async ({ page }) => {
  const code = `E2E${run}`;
  await login(page, "warehouse@example.com");
  await page.goto("/warehouses");
  await page.getByRole("button", { name: "New warehouse" }).click();
  const dialog = page.getByRole("dialog", { name: "New warehouse" });
  await dialog.getByLabel("Code").fill(code);
  await dialog.getByLabel("Name (English)").fill(`E2E store ${run}`);
  await dialog.getByLabel("Name (Arabic)").fill(`مخزن ${run}`);
  await dialog.getByRole("button", { name: "Save" }).click();
  await page.waitForURL(/\/warehouses\/[^/]+$/);

  await page.goto("/stocktakes");
  await page.getByLabel("Warehouse").first().selectOption({ label: `${code} · E2E store ${run}` });
  await page.getByRole("button", { name: "Start stocktake" }).click();
  await page.waitForURL(/\/stocktakes\/[^/]+$/);
  await expect(page.getByText("The warehouse had no stock when the count started.")).toBeVisible();

  // Found during the count: two boxes of screws.
  await pickProduct(page, "Add a product found during the count", "SCR-BOX-100");
  await page.getByRole("button", { name: "Add to count" }).click();
  await expect(page.getByRole("textbox", { name: "Counted SCR-BOX-100" })).toBeVisible();
  await page.getByRole("textbox", { name: "Counted SCR-BOX-100" }).fill("2");
  await page.getByRole("textbox", { name: "Explanation SCR-BOX-100" }).fill("Left over from a job");
  await page.getByRole("button", { name: "Submit for approval" }).click();
  await page.getByRole("dialog", { name: /Submit stocktake/ }).getByRole("button", { name: "Submit for approval" }).click();
  await expect(page.getByRole("heading", { level: 1 })).toContainText("Awaiting approval");

  await page.getByRole("button", { name: "Approve" }).click();
  await page.getByRole("dialog", { name: /Approve stocktake/ }).getByRole("button", { name: "Approve" }).click();
  await expect(page.getByRole("heading", { level: 1 })).toContainText("Approved");
  await page.getByRole("link", { name: /^Adjustment ADJ-/ }).click();
  await expect(page.getByRole("heading", { level: 1 })).toContainText("Posted");
  await expect(page.locator("table").last()).toContainText("Adjustment increase");
});

test("the store keeper prepares an adjustment but cannot post it; a technician sees only their van", async ({ page, browser }) => {
  await login(page, "store@example.com");
  await page.goto("/stock/documents/new?type=ADJUSTMENT");
  await expect(page.getByRole("button", { name: "Save and post" })).toHaveCount(0);
  await page.getByRole("combobox", { name: "Warehouse", exact: true }).selectOption({ label: "MAIN · Main store" });
  await pickProduct(page, "Line 1", "CBL-CAT6");
  await page.getByLabel("Direction").selectOption({ label: "Decrease (missing or damaged)" });
  await page.getByLabel(/^Quantity/).fill("1.5");
  await page.getByLabel("Reason").fill(`Damaged ${run}`);
  await page.getByRole("button", { name: "Save draft" }).click();
  await page.waitForURL(/\/stock\/documents\/(?!new)[^/]+$/);
  await expect(page.getByRole("heading", { level: 1 })).toContainText("Draft");
  await expect(page.getByRole("button", { name: "Post" })).toHaveCount(0);
  // The draft is closed again (it never moved stock).
  await page.getByRole("button", { name: "Cancel draft" }).click();
  await page.getByRole("dialog", { name: /Cancel draft/ }).getByRole("button", { name: "Cancel draft" }).click();
  await expect(page.getByRole("heading", { level: 1 })).toContainText("Cancelled");

  const tech = await (await browser.newContext({ baseURL: test.info().project.use.baseURL })).newPage();
  await login(tech, "karim.tech@example.com");
  await tech.goto("/stock");
  await expect(tech.getByRole("heading", { name: "My van stock" })).toBeVisible();
  const rows = tech.locator("tbody tr");
  await expect(rows.first()).toBeVisible();
  for (const text of await rows.allInnerTexts()) expect(text).toContain("VAN-KARIM");
  await expect(tech.getByRole("button", { name: "New document" })).toHaveCount(0);
  await tech.goto("/warehouses");
  await expect(tech).toHaveURL(/access-denied/);
});

test("the inventory pages work in Arabic, right to left", async ({ browser }) => {
  const context = await browser.newContext({ baseURL: test.info().project.use.baseURL, storageState: { cookies: [], origins: [] } });
  const page = await context.newPage();
  await context.addCookies([{ name: "ims_locale", value: "ar", url: test.info().project.use.baseURL! }]);
  await page.goto("/login");
  await page.locator('input[type="email"]').fill("warehouse@example.com");
  await page.locator('input[autocomplete="current-password"]').fill(PASSWORD);
  await page.getByRole("button", { name: "تسجيل الدخول" }).click();
  await page.waitForURL((u) => !u.pathname.startsWith("/login"));

  await page.goto("/stock");
  await expect(page.locator("html")).toHaveAttribute("dir", "rtl");
  await expect(page.getByRole("heading", { name: "رصيد المخزون" })).toBeVisible();
  await expect(page.getByRole("navigation").first().getByText("المخزون", { exact: true })).toBeVisible();
  await expect(page.getByRole("table").first()).toContainText("قفل ييل لينوس L2");

  await page.goto("/stock/documents/new?type=RECEIPT");
  await expect(page.getByRole("heading", { name: "إذن استلام جديد" })).toBeVisible();
  await page.getByRole("button", { name: "حفظ كمسودة" }).click();
  await expect(page.getByText("اختر المخزن الذي تدخل إليه البضاعة")).toBeVisible();

  await page.goto("/products");
  await expect(page.getByRole("heading", { name: "الأصناف" })).toBeVisible();
  await context.close();
});
