import { expect, test } from "@playwright/test";
import { PASSWORD, futureDate, login } from "./helpers";

/**
 * Custom roles end to end: an Admin creates a role from a built-in one, narrows it, gives it to a
 * Sales employee, and the server refuses what the role no longer allows. The test puts the person
 * back to their role's defaults and deactivates the role, so it can run again on the same database.
 */
const SALES_NAME = "Mona Adel";
const SALES_EMAIL = "mona.sales@example.com";

test("an Admin creates a custom role, gives it to a Sales employee and the server enforces it", async ({ page, browser }) => {
  await login(page, "admin@example.com");
  await page.goto("/users");
  await page.getByRole("link", { name: "Roles and permissions" }).click();
  await expect(page.getByRole("heading", { name: "Roles and permissions" })).toBeVisible();
  await expect(page.locator('[data-builtin-role="INSTALLATION_MANAGER"]')).toContainText("Installation manager");

  await page.locator('[data-builtin-role="SALES"]').getByRole("link", { name: "Custom role from this" }).click();
  const roleName = `E2E view-only sales ${Date.now()}`;
  await page.getByRole("textbox", { name: "Name", exact: true }).fill(roleName);
  await page.getByLabel("Level: Appointments and scheduling").selectOption("view");
  await page.getByLabel("Reason (recorded in the audit log)").fill("e2e");
  await page.getByRole("button", { name: "Create role" }).click();
  await expect(page.getByRole("heading", { name: `Role: ${roleName}` })).toBeVisible();
  const roleUrl = page.url();

  // Give it to the Sales employee from their permission screen.
  await page.goto("/users");
  const href = await page.getByRole("link", { name: `Permissions: ${SALES_NAME}` }).getAttribute("href");
  const userId = href!.split("/")[2]!;
  try {
    await page.goto(href!);
    await page.getByLabel("Role", { exact: true }).selectOption({ label: roleName });
    page.once("dialog", (d) => void d.accept());
    await page.getByRole("button", { name: "Apply role" }).click();
    await expect(page.getByText("Permissions saved.")).toBeVisible();

    // The employee can still see bookings but can no longer create one, through the API either.
    const ctx = await browser.newContext({ baseURL: test.info().project.use.baseURL });
    const sales = await ctx.newPage();
    await login(sales, SALES_EMAIL);
    expect((await sales.request.get("/api/appointments")).status()).toBe(200);
    const res = await sales.request.post("/api/appointments", {
      data: { customer: { name: "E2E Role", phone: "+20 100 555 0199" }, location: { area: "Maadi" }, productCategory: "SMART_LOCK", date: futureDate(3), startTime: "10:00", durationMinutes: 60, technicianIds: [] },
    });
    expect(res.status()).toBe(403);
    await ctx.close();

    // The role page lists its member.
    await page.goto(roleUrl);
    await expect(page.getByRole("link", { name: SALES_NAME })).toBeVisible();
  } finally {
    expect((await page.request.put(`/api/users/${userId}/access`, { data: { mode: "role", accessRoleId: null, reason: "e2e clean-up" } })).ok()).toBeTruthy();
    const roleId = roleUrl.split("/").pop()!;
    expect((await page.request.put(`/api/access-roles/${roleId}`, { data: { name: roleName, isActive: false, reason: "e2e clean-up" } })).ok()).toBeTruthy();
  }
});

test.describe("Arabic, phone", () => {
  test.use({ viewport: { width: 390, height: 844 } });

  test("the roles page is right to left and fits a phone screen", async ({ page }) => {
    await page.context().addCookies([{ name: "ims_locale", value: "ar", url: process.env.E2E_BASE_URL ?? "http://localhost:3000" }]);
    await page.goto("/login");
    await page.locator('input[type="email"]').fill("admin@example.com");
    await page.locator('input[autocomplete="current-password"]').fill(PASSWORD);
    await page.getByRole("button", { name: "تسجيل الدخول" }).click();
    await page.waitForURL((u) => !u.pathname.startsWith("/login"));
    for (const path of ["/users/roles", "/users/roles/new?base=TECHNICIAN"]) {
      await page.goto(path);
      await expect(page.locator("html")).toHaveAttribute("dir", "rtl");
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
      expect(overflow, path).toBeLessThanOrEqual(1);
    }
    await expect(page.getByRole("heading", { name: "دور مخصص جديد" })).toBeVisible();
  });
});
