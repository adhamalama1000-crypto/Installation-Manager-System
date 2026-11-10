import { expect, test } from "@playwright/test";
import { login } from "./helpers";

/**
 * Product identification through the real UI: automatic codes, "save and add another", colour
 * variants with their own codes and prices, and document pickers that offer variants (never the
 * product that groups them). Runs against the seeded database (Smart Lock Model X with Black,
 * Silver and Gold); everything created here carries a per-run name.
 */
const run = Date.now().toString(36).toUpperCase().slice(-6);

test("a product gets its code automatically and the form is ready for the next one", async ({ page }) => {
  await login(page, "warehouse@example.com");
  await page.goto("/products/new");
  await page.getByLabel("Name (English)").fill(`Auto bracket ${run}`);
  await page.getByLabel("Name (Arabic)").fill(`كتيفة تلقائية ${run}`);
  await page.getByRole("combobox", { name: "Category" }).click();
  await page.getByRole("option", { name: "Smart locks, LCK", exact: true }).click();
  await page.getByLabel("Unit of measure").selectOption({ label: "Piece (PCS)" });
  await page.getByRole("button", { name: "Save and add another" }).click();
  // The toast names the generated code; the names are cleared, the category is kept.
  await expect(page.getByText(/LCK-\d{5}/).first()).toBeVisible();
  await expect(page.getByLabel("Name (English)")).toHaveValue("");
  await expect(page.getByLabel("Name (English)")).toBeFocused();
  await expect(page.getByRole("combobox", { name: "Category" })).toHaveValue("Smart locks");

  await page.getByLabel("Name (English)").fill(`Auto bracket B ${run}`);
  await page.getByLabel("Name (Arabic)").fill(`كتيفة ب ${run}`);
  await page.getByLabel("Serial numbers").selectOption("OPTIONAL");
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await page.waitForURL(/\/products\/(?!new)[^/]+$/);
  await expect(page.getByRole("heading", { level: 1 })).toContainText(/LCK-\d{5}/);
  await expect(page.getByText("Optional (record when known)").first()).toBeVisible();
});

test("variants: list, add several at once, edit one, and pick them on a stock document", async ({ page }) => {
  await login(page, "warehouse@example.com");
  await page.goto("/products?q=Model+X");
  await expect(page.locator("tbody tr")).toHaveCount(1);
  await expect(page.locator("tbody tr").first()).toContainText(/\d+ variants/); // 3 in the seed, more after earlier runs
  await page.locator("tbody tr").first().getByRole("link").first().click();
  await expect(page.getByRole("heading", { level: 1 })).toContainText("Smart Lock Model X");
  await expect(page.getByRole("heading", { name: "Variants", exact: true })).toBeVisible();
  await expect(page.getByRole("link", { name: "LCK-00001-BLACK" })).toBeVisible();

  // Two more colours in one go; their codes come from the English names.
  const colour = `Blue${run}`;
  await page.getByLabel("Variant name (English) 1").fill(colour);
  await page.getByLabel("Variant name (Arabic) 1").fill(`أزرق ${run}`);
  await page.getByRole("button", { name: "Add a row" }).click();
  await page.getByLabel("Variant name (English) 2").fill(`Red${run}`);
  await page.getByLabel("Variant name (Arabic) 2").fill(`أحمر ${run}`);
  await page.getByLabel("Selling price (EGP) 2").fill("6100");
  await page.getByRole("button", { name: "Create variants" }).click();
  await expect(page.getByText("2 variants created.")).toBeVisible();
  const code = `LCK-00001-${colour.toUpperCase().slice(0, 8)}`; // suffixes keep at most 8 characters
  await expect(page.getByRole("link", { name: code })).toBeVisible();

  // Edit one variant's price in its dialog.
  await page.getByRole("button", { name: `Edit variant ${code}` }).click();
  const dialog = page.getByRole("dialog", { name: new RegExp(`Edit variant · ${code}`) });
  await dialog.getByLabel("Selling price (EGP)").fill("6250");
  await dialog.getByRole("button", { name: "Save changes" }).click();
  await expect(page.getByText("Variant saved.")).toBeVisible();
  await expect(page.locator("tr").filter({ hasText: code })).toContainText("6,250");

  // The document picker lists the variants, never the product that groups them.
  await page.goto("/stock/documents/new?type=RECEIPT");
  await page.getByRole("textbox", { name: "Line 1" }).fill("Model X");
  const list = page.getByRole("listbox", { name: "Line 1" });
  await expect(list.getByRole("button").filter({ hasText: "LCK-00001-BLACK" })).toBeVisible();
  await expect(list.getByRole("button").filter({ hasText: /LCK-00001\b(?!-)/ })).toHaveCount(0);
});
