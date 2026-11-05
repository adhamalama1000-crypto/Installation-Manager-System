import { expect, test } from "@playwright/test";
import ExcelJS from "exceljs";
import { login } from "./helpers";
import { PRODUCT_COLUMNS, headerOf } from "../src/lib/product-import";

/**
 * Bulk product import through the real UI (template download, preview with row errors, import),
 * and the supplier master. Everything carries a per-run code.
 */
const run = Date.now().toString(36).toUpperCase().slice(-6);

async function xlsx(rows: Record<string, string>[]) {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet("Products");
  ws.addRow(PRODUCT_COLUMNS.map(headerOf));
  for (const r of rows) ws.addRow(PRODUCT_COLUMNS.map((c) => r[c.key] ?? ""));
  return Buffer.from(await wb.xlsx.writeBuffer());
}

test("the warehouse manager previews an Excel file, sees the row errors, and imports the valid rows", async ({ page }) => {
  await login(page, "warehouse@example.com");
  await page.goto("/products/import");
  await expect(page.getByRole("heading", { level: 1, name: "Import and export products" })).toBeVisible();
  const template = await page.request.get("/api/products/import/template");
  expect(template.ok()).toBe(true);
  expect(template.headers()["content-type"]).toContain("spreadsheetml");

  const file = await xlsx([
    { sku: `IMP-${run}`, name_en: `Imported lock ${run}`, name_ar: `قفل مستورد ${run}`, unit: "PCS", category: "Smart locks", purchase_cost: "100" },
    { parent_sku: `IMP-${run}`, variant_en: "Black", variant_ar: "أسود" },
    { sku: `BAD-${run}`, name_en: "Bad unit", name_ar: "وحدة خطأ", unit: "litre" },
  ]);
  await page.getByLabel("Excel file (.xlsx)").setInputFiles({ name: "products.xlsx", mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", buffer: file });
  await page.getByRole("button", { name: "Check the file" }).click();
  await expect(page.getByText("2 to create · 0 to update · 0 skipped · 1 with errors")).toBeVisible();
  await expect(page.getByText("Unknown unit litre.")).toBeVisible();
  await expect(page.getByText(`IMP-${run}-BLACK`)).toBeVisible();
  // Nothing is imported while a row has an error, unless the user chooses to skip it.
  await expect(page.getByRole("button", { name: "Import" })).toBeDisabled();
  await page.getByLabel("Import the valid rows and skip the rows with errors").check();
  await page.getByRole("button", { name: "Import" }).click();
  await expect(page.getByText("Import finished: 2 created, 0 updated, 0 skipped, 1 not imported.").first()).toBeVisible();

  await page.goto(`/products?q=IMP-${run}`);
  await expect(page.locator("tbody tr")).toHaveCount(1);
  await expect(page.locator("tbody tr").first()).toContainText("1 variant");
});

test("suppliers: add one, and pick it on a goods receipt", async ({ page }) => {
  await login(page, "warehouse@example.com");
  await page.goto("/suppliers");
  await page.getByRole("button", { name: "New supplier" }).click();
  const dialog = page.getByRole("dialog", { name: "New supplier" });
  await dialog.getByRole("textbox", { name: "Name", exact: true }).fill(`Delta ${run}`);
  await dialog.getByLabel("Phone").fill("+20 100 555 0101");
  await dialog.getByRole("button", { name: "Save", exact: true }).click();
  await page.waitForURL(/\/suppliers\/[^/]+$/);
  await expect(page.getByRole("heading", { level: 1 })).toContainText(`Delta ${run}`);
  await expect(page.getByRole("heading", { level: 1 })).toContainText(/SUP-\d{5}/);

  await page.goto("/stock/documents/new?type=RECEIPT");
  await page.getByRole("combobox", { name: "Supplier" }).click();
  await page.getByRole("combobox", { name: "Supplier" }).fill(`Delta ${run}`);
  await page.getByRole("option", { name: new RegExp(`Delta ${run}`) }).click();
  await expect(page.getByRole("combobox", { name: "Supplier" })).toHaveValue(`Delta ${run}`);
});
