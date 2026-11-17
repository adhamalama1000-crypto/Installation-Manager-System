import { expect, test, type APIRequestContext } from "@playwright/test";
import { PASSWORD, login } from "./helpers";

/**
 * Warehouse items and planned stocktakes end to end: a warehouse manager locks an item (the edit
 * form disappears and the API refuses changes), plans a one-time stocktake for a store keeper,
 * who starts it, counts 95 where the system has 100 and submits; the manager (who did not count)
 * approves it and the adjustment is posted. Each run uses its own warehouse and product.
 */
const MANAGER = "warehouse@example.com";
const STORE = "store@example.com";

async function api(baseURL: string, email: string): Promise<APIRequestContext> {
  const { request } = await import("@playwright/test");
  const ctx = await request.newContext({ baseURL });
  expect((await ctx.post("/api/auth/login", { data: { email, password: PASSWORD } })).ok()).toBeTruthy();
  return ctx;
}

test("a warehouse manager locks an item; the edit form disappears and the API refuses changes", async ({ page, baseURL }) => {
  const m = await api(baseURL!, MANAGER);
  const sku = `E2E-LK-${Date.now()}`;
  const created = await m.post("/api/products", { data: { sku, nameEn: "E2E lockable", nameAr: "صنف للقفل", unitId: "unit-pcs" } });
  expect(created.status()).toBe(201);
  const id = (await created.json()).product.id as string;

  await login(page, MANAGER);
  await page.goto(`/products/${id}`);
  await expect(page.getByRole("heading", { name: "Edit product" })).toBeVisible();
  await page.getByRole("button", { name: "Lock" }).click();
  const dialog = page.getByRole("dialog", { name: `Lock ${sku}?` });
  await dialog.getByLabel("Reason (recorded in the audit log)").fill("e2e: catalogue checked");
  await dialog.getByRole("button", { name: "Lock" }).click();
  await expect(page.getByText("Item locked.")).toBeVisible();
  await expect(page.getByText("Locked", { exact: true })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Edit product" })).toHaveCount(0);
  const refused = await m.patch(`/api/products/${id}`, { data: { sku, nameEn: "Changed", nameAr: "صنف", unitId: "unit-pcs" } });
  expect(refused.status()).toBe(422);
  expect(JSON.stringify(await refused.json())).toContain("locked");

  // A store keeper sees the item but cannot unlock it.
  const s = await api(baseURL!, STORE);
  expect((await s.post(`/api/products/${id}/state`, { data: { action: "unlock" } })).status()).toBe(403);

  await page.getByRole("button", { name: "Unlock" }).click();
  await page.getByRole("dialog", { name: `Unlock ${sku}?` }).getByRole("button", { name: "Unlock" }).click();
  await expect(page.getByText("Item unlocked.")).toBeVisible();
  await expect(page.getByRole("heading", { name: "Edit product" })).toBeVisible();
  await m.dispose();
  await s.dispose();
});

test("a planned stocktake: scheduled by the manager, counted by the store keeper, approved by someone who did not count", async ({ browser, baseURL }) => {
  const m = await api(baseURL!, MANAGER);
  const stamp = Date.now();
  const w = await m.post("/api/warehouses", { data: { code: `E2E${String(stamp).slice(-6)}`, nameEn: "E2E count store", nameAr: "مخزن جرد", kind: "WAREHOUSE" } });
  expect(w.status()).toBe(201);
  const warehouse = (await w.json()).warehouse as { id: string; code: string };
  const p = await m.post("/api/products", { data: { sku: `E2E-CNT-${stamp}`, nameEn: "E2E counted item", nameAr: "صنف للجرد", unitId: "unit-pcs", purchaseCost: 50 } });
  const productId = (await p.json()).product.id as string;
  const today = new Intl.DateTimeFormat("en-CA", { timeZone: "Africa/Cairo" }).format(new Date());
  const receipt = await m.post("/api/stock-documents", { data: { type: "RECEIPT", toWarehouseId: warehouse.id, documentDate: today, lines: [{ productId, quantity: 100 }], clientRequestId: crypto.randomUUID(), post: true } });
  expect(receipt.status(), await receipt.text()).toBe(201);

  // The manager plans a one-time stocktake for the store keeper from the schedules page.
  const manager = await (await browser.newContext({ baseURL })).newPage();
  await login(manager, MANAGER);
  await manager.goto("/stocktakes/schedules");
  await manager.getByRole("button", { name: "New schedule" }).click();
  const form = manager.getByRole("dialog", { name: "New schedule" });
  const name = `E2E count ${stamp}`;
  await form.getByRole("textbox", { name: "Name", exact: true }).fill(name);
  await form.getByLabel("Warehouse", { exact: true }).selectOption(warehouse.id);
  await form.getByLabel("Type", { exact: true }).selectOption("CUSTOM");
  await form.getByLabel("Repeats", { exact: true }).selectOption("NONE");
  await form.getByLabel("First day", { exact: true }).fill(today);
  await form.getByLabel("Start time", { exact: true }).fill("00:00");
  await form.getByLabel("Time allowed (minutes)", { exact: true }).fill("1440");
  await form.getByLabel("Sameh Store").check();
  await form.getByRole("button", { name: "Save" }).click();
  await expect(manager.getByText("Schedule saved. Its planned sessions are up to date.")).toBeVisible();
  await expect(manager.locator(`[data-schedule="${name}"]`)).toBeVisible();

  // The store keeper finds it in the list, starts it and counts.
  const store = await (await browser.newContext({ baseURL })).newPage();
  await login(store, STORE);
  await store.goto(`/stocktakes?warehouseId=${warehouse.id}`);
  await store.getByRole("link", { name: /STK-/ }).first().click();
  await expect(store.getByText(name)).toBeVisible();
  await store.getByRole("button", { name: "Start counting" }).click();
  await store.getByRole("dialog", { name: /Start STK-/ }).getByRole("button", { name: "Start counting" }).click();
  await expect(store.getByText("Counting started.")).toBeVisible();
  await store.getByLabel(/^Counted E2E-CNT-/).fill("95");
  await store.getByLabel(/^Damaged E2E-CNT-/).fill("2");
  await store.getByLabel(/^Explanation E2E-CNT-|^Explain E2E-CNT-/).fill("5 missing, 2 damaged");
  await store.getByRole("button", { name: "Submit for approval" }).click();
  await store.getByRole("dialog", { name: /Submit stocktake/ }).getByRole("button", { name: "Submit for approval" }).click();
  await expect(store.getByText("Awaiting approval").first()).toBeVisible();
  const url = store.url();

  // The manager did not count: they may approve; the -5 is posted as an adjustment.
  await manager.goto(url);
  await manager.getByRole("button", { name: "Approve" }).click();
  await manager.getByRole("dialog", { name: /Approve stocktake/ }).getByRole("button", { name: "Approve" }).click();
  await expect(manager.getByRole("link", { name: /ADJ-/ })).toBeVisible();
  const balances = await m.get(`/api/inventory/balances?warehouseId=${warehouse.id}`);
  expect(JSON.stringify(await balances.json())).toContain("95");
  await m.dispose();
});

test.describe("Arabic, phone", () => {
  test.use({ viewport: { width: 390, height: 844 } });

  test("the stocktake dashboard and schedules read right to left and fit a phone", async ({ page }) => {
    await page.context().addCookies([{ name: "ims_locale", value: "ar", url: process.env.E2E_BASE_URL ?? "http://localhost:3000" }]);
    await page.goto("/login");
    await page.locator('input[type="email"]').fill(MANAGER);
    await page.locator('input[autocomplete="current-password"]').fill(PASSWORD);
    await page.getByRole("button", { name: "تسجيل الدخول" }).click();
    await page.waitForURL((u) => !u.pathname.startsWith("/login"));
    for (const path of ["/stocktakes/dashboard", "/stocktakes/schedules", "/stocktakes"]) {
      await page.goto(path);
      await expect(page.locator("html")).toHaveAttribute("dir", "rtl");
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
      expect(overflow, path).toBeLessThanOrEqual(1);
    }
    await page.goto("/stocktakes/dashboard");
    await expect(page.getByRole("heading", { name: "لوحة الجرد" })).toBeVisible();
  });
});
