import { expect, test } from "@playwright/test";
import { PASSWORD, login } from "./helpers";

test("unauthenticated users are sent to the login page", async ({ page }) => {
  await page.goto("/appointments");
  await expect(page).toHaveURL(/\/login/);
  await expect(page.getByRole("img", { name: /aura/ }).first()).toBeVisible();
});

test("wrong password shows a clear error", async ({ page }) => {
  await page.goto("/login");
  await page.getByLabel("Email").fill("viewer@example.com");
  await page.getByLabel("Password", { exact: true }).fill("not-the-password1");
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page.getByText("Invalid email or password.")).toBeVisible();
});

test("technicians are read-only and only see their own appointments", async ({ page, playwright }) => {
  await login(page, "karim.tech@example.com");
  await expect(page.getByRole("link", { name: "New appointment" })).toHaveCount(0);
  await page.goto("/appointments");
  await expect(page.getByRole("heading", { name: "My appointments" })).toBeVisible();
  const rows = page.locator("table tbody tr");
  const n = await rows.count();
  for (let i = 0; i < Math.min(n, 10); i++) await expect(rows.nth(i)).toContainText("Karim Fathy");

  // Open one assigned appointment: no edit actions.
  if (n > 0) {
    await rows.first().locator("a").first().click();
    await expect(page.getByText("Read-only")).toBeVisible();
    await expect(page.getByRole("link", { name: "Edit" })).toHaveCount(0);
    const id = page.url().split("/").pop()!;
    const patch = await page.request.patch(`/api/appointments/${id}`, { data: {} });
    expect(patch.status()).toBe(403);
  }

  // Someone else's appointment (found through a Sales session) is indistinguishable from a missing one.
  const sales = await playwright.request.newContext({ baseURL: new URL(page.url()).origin });
  await sales.post("/api/auth/login", { data: { email: "omar.sales@example.com", password: PASSWORD } });
  const list = await (await sales.get("/api/appointments?pageSize=200")).json();
  const notMine = (list.rows as { id: string; technicians: { name: string }[] }[]).find(
    (r) => r.technicians.length > 0 && !r.technicians.some((t) => t.name === "Karim Fathy"),
  );
  expect(notMine).toBeTruthy();
  const res = await page.goto(`/appointments/${notMine!.id}`);
  expect(res?.status()).toBe(404);
  expect((await page.request.get(`/api/appointments/${notMine!.id}`)).status()).toBe(404);
  await sales.dispose();
  await page.goto("/users");
  await expect(page).toHaveURL(/access-denied/);
});

test("viewers cannot modify data or reach admin pages", async ({ page }) => {
  await login(page, "viewer@example.com");
  await expect(page.getByRole("link", { name: "New appointment" })).toHaveCount(0);
  await page.goto("/settings");
  await expect(page).toHaveURL(/access-denied/);
  const res = await page.request.post("/api/appointments", { data: {} });
  expect(res.status()).toBe(403);
});
