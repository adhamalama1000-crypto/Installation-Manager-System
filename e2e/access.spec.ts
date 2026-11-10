import { expect, test, type Page } from "@playwright/test";
import { PASSWORD, login } from "./helpers";

/**
 * The permission screen end to end: an Admin narrows a Sales employee's access, the server enforces
 * it on the employee's next request, the audit log shows who changed what and why, and the screen
 * works in Arabic (right to left) and at phone width. Every test puts the seeded person back to
 * their role's defaults, so the specs can run again on the same database.
 */
const SALES_NAME = "Mona Adel";
const SALES_EMAIL = "mona.sales@example.com";

async function userIdOf(page: Page, name: string) {
  await page.goto("/users");
  const href = await page.getByRole("link", { name: `Permissions: ${name}` }).getAttribute("href");
  return href!.split("/")[2]!;
}

async function resetAccess(page: Page, id: string) {
  const res = await page.request.put(`/api/users/${id}/access`, { data: { mode: "reset", reason: "e2e clean-up" } });
  expect(res.ok()).toBeTruthy();
}

test("an Admin limits a Sales employee to viewing their own bookings; the server enforces it and the audit log records it", async ({ page, browser }) => {
  await login(page, "admin@example.com");
  const id = await userIdOf(page, SALES_NAME);
  await resetAccess(page, id);
  try {
    await page.goto(`/users/${id}/access`);
    await expect(page.getByRole("heading", { name: `Permissions of ${SALES_NAME}` })).toBeVisible();
    const level = page.getByLabel("Level: Appointments and scheduling");
    const scope = page.getByLabel("Records: Appointments and scheduling");
    await expect(level).toHaveValue("full");
    await expect(scope).toHaveValue("ALL");

    await level.selectOption("view");
    await scope.selectOption("OWN");
    await expect(page.getByText(/unsaved change/)).toBeVisible();
    await page.getByLabel("Reason (recorded in the audit log)").fill("e2e: trainee for two weeks");
    await page.getByRole("button", { name: "Save permissions" }).click();
    await expect(page.getByText("Permissions saved.")).toBeVisible();

    // What the server stored comes back after a reload.
    await page.reload();
    await expect(page.getByLabel("Level: Appointments and scheduling")).toHaveValue("view");
    await expect(page.getByLabel("Records: Appointments and scheduling")).toHaveValue("OWN");

    // The employee's own session: no booking button, and the API refuses a booking made by hand.
    const baseURL = test.info().project.use.baseURL!;
    const ctx = await browser.newContext({ baseURL });
    const mona = await ctx.newPage();
    await login(mona, SALES_EMAIL);
    await mona.goto("/appointments");
    await expect(mona.getByRole("link", { name: "New appointment" })).toHaveCount(0);
    expect((await mona.request.post("/api/appointments", { data: {} })).status()).toBe(403);
    // Nor can they open the permission screen or the API behind it, for anyone, themselves included.
    expect((await mona.request.get(`/api/users/${id}/access`)).status()).toBe(403);
    expect((await mona.request.put(`/api/users/${id}/access`, { data: { mode: "reset" } })).status()).toBe(403);
    expect((await mona.request.get("/api/audit/export")).status()).toBe(403);
    await mona.goto(`/users/${id}/access`);
    await expect(mona.getByRole("heading", { name: `Permissions of ${SALES_NAME}` })).toHaveCount(0);
    await ctx.close();

    // The audit log, filtered to permission changes.
    await page.goto("/audit");
    await page.getByLabel("Module").selectOption("users");
    await page.getByLabel("Action").selectOption("USER_ACCESS_CHANGED");
    await page.getByRole("button", { name: "Apply" }).click();
    const entry = page.locator("li").filter({ hasText: "e2e: trainee for two weeks" }).first();
    await expect(entry).toBeVisible();
    await expect(entry).toContainText("USER_ACCESS_CHANGED");
    await expect(entry).toContainText(`PUT /api/users/${id}/access`);
  } finally {
    await resetAccess(page, id);
  }
  await page.goto(`/users/${id}/access`);
  await expect(page.getByLabel("Level: Appointments and scheduling")).toHaveValue("full");
});

test("an Admin's own permissions are locked, and an audit entry is corrected with a new entry", async ({ page }) => {
  await login(page, "admin@example.com");
  const id = await userIdOf(page, "System Admin");
  await page.goto(`/users/${id}/access`);
  await expect(page.getByText("Admins always have every permission")).toBeVisible();
  await expect(page.getByLabel("Level: Appointments and scheduling")).toBeDisabled();
  await expect(page.getByRole("button", { name: "Save permissions" })).toHaveCount(0);

  await page.goto(`/audit?module=auth&action=LOGIN_SUCCEEDED`);
  const first = page.locator("li").filter({ hasText: "LOGIN_SUCCEEDED" }).first();
  await expect(first).toContainText("POST /api/auth/login");
  const note = `e2e correction ${Date.now()}`;
  await first.getByRole("button", { name: "Add a correction" }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByRole("textbox", { name: "What was wrong and what is right" }).fill(note);
  await dialog.getByRole("textbox", { name: "Reason", exact: true }).fill("e2e: checking corrections");
  await dialog.getByRole("button", { name: "Save" }).click();
  await expect(dialog).toBeHidden();
  await page.goto(`/audit?action=AUDIT_CORRECTION`);
  await expect(page.locator("li").filter({ hasText: note }).first()).toContainText("e2e: checking corrections");
});

test.describe("in Arabic", () => {
  test.use({ storageState: { cookies: [], origins: [] } });

  test("the permission screen reads right to left and fits a phone", async ({ page }) => {
    await page.context().addCookies([{ name: "ims_locale", value: "ar", url: process.env.E2E_BASE_URL ?? "http://localhost:3000" }]);
    await page.goto("/login");
    await page.locator('input[type="email"]').fill("admin@example.com");
    await page.locator('input[autocomplete="current-password"]').fill(PASSWORD);
    await page.getByRole("button", { name: "تسجيل الدخول" }).click();
    await page.waitForURL((u) => !u.pathname.startsWith("/login"));

    await page.goto("/users");
    const href = await page.getByRole("link", { name: `الصلاحيات: ${SALES_NAME}` }).getAttribute("href");
    await page.goto(href!);
    await expect(page.locator("html")).toHaveAttribute("dir", "rtl");
    await expect(page.getByRole("heading", { level: 1, name: new RegExp(`صلاحيات ${SALES_NAME}`) })).toBeVisible();
    await expect(page.getByRole("heading", { name: "الصلاحيات الفعلية" })).toBeVisible();
    await expect(page.getByRole("button", { name: "حفظ الصلاحيات" })).toBeVisible();

    await page.setViewportSize({ width: 390, height: 844 });
    await page.reload();
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    expect(overflow, "the page itself never scrolls sideways; the matrix scrolls inside its card").toBeLessThanOrEqual(1);
    await expect(page.getByRole("button", { name: "حفظ الصلاحيات" })).toBeVisible();
  });
});
