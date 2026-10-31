import { expect, test } from "@playwright/test";
import { futureDate, login, PASSWORD, technicianIds } from "./helpers";

test("Sales opens a complaint, the Admin assigns it, the technician resolves it and Sales closes it", async ({ browser, playwright }) => {
  const baseURL = test.info().project.use.baseURL!;
  const api = await playwright.request.newContext({ baseURL });
  await api.post("/api/auth/login", { data: { email: "mona.sales@example.com", password: PASSWORD } });
  const mostafa = (await technicianIds(api)).find((t) => t.name === "Mostafa Ali")!;
  const customer = `E2E Complaint ${Date.now()}`;
  const created = await api.post("/api/appointments", {
    data: {
      customer: { name: customer, phone: "+20 100 555 0166" },
      location: { area: "Nasr City" },
      productCategory: "SMART_LOCK",
      visitType: "INSTALLATION",
      date: futureDate(260),
      startTime: "15:00",
      durationMinutes: 60,
      technicianIds: [mostafa.id],
    },
  });
  expect(created.status()).toBe(201);
  const { appointment } = await created.json();
  await api.dispose();

  // Sales opens it from the visit.
  const sales = await (await browser.newContext({ baseURL })).newPage();
  await login(sales, "mona.sales@example.com");
  await sales.goto(`/appointments/${appointment.id}`);
  await sales.getByRole("button", { name: "Open complaint" }).click();
  const dialog = sales.getByRole("dialog", { name: "New complaint" });
  await dialog.getByRole("button", { name: "Open complaint" }).click();
  await expect(dialog.getByText(/Complaint is required/)).toBeVisible();
  await dialog.getByLabel("Complaint").fill("The lock beeps every night at 2 am.");
  await dialog.getByRole("button", { name: "Open complaint" }).click();
  await sales.waitForURL(/\/complaints\/[^/]+$/);
  const url = sales.url();
  await expect(sales.getByText("The lock beeps every night at 2 am.")).toBeVisible();
  await expect(sales.getByRole("heading", { level: 1 }).getByText("New", { exact: true })).toBeVisible();

  // The head of installations assigns it.
  const admin = await (await browser.newContext({ baseURL })).newPage();
  await login(admin, "admin@example.com");
  await admin.goto(url);
  await admin.getByLabel("Technician").selectOption({ label: "Mostafa Ali" });
  await admin.getByRole("button", { name: "Assign" }).click();
  await expect(admin.getByRole("heading", { level: 1 }).getByText("Assigned", { exact: true })).toBeVisible();

  // The technician finds it in their list and writes the resolution.
  const tech = await (await browser.newContext({ baseURL })).newPage();
  await login(tech, "mostafa.tech@example.com");
  await tech.goto("/complaints");
  await tech.getByRole("link", { name: new RegExp(customer) }).click();
  await tech.getByLabel("Resolution").fill("Turned off the low-battery night alert and replaced the batteries.");
  await tech.getByRole("button", { name: "Save resolution" }).click();
  await expect(tech.getByRole("heading", { level: 1 }).getByText("Resolved", { exact: true })).toBeVisible();
  await expect(tech.getByRole("button", { name: "Close complaint" })).toHaveCount(0);

  // Sales calls the customer and closes it.
  await sales.reload();
  await sales.getByRole("button", { name: "Close complaint" }).click();
  await expect(sales.getByRole("heading", { level: 1 }).getByText("Closed", { exact: true })).toBeVisible();
  await expect(sales.getByRole("button", { name: "Reopen" })).toBeVisible();
});

test("Sales records the customer's satisfaction from the after-sales list", async ({ page, playwright }) => {
  const baseURL = test.info().project.use.baseURL!;
  const api = await playwright.request.newContext({ baseURL });
  await api.post("/api/auth/login", { data: { email: "mona.sales@example.com", password: PASSWORD } });
  // A visit 5 or 6 days ago (whichever is not the seeded closed Friday). No technician, so reruns
  // never clash; Sales records it as done from the office.
  const day = [5, 6].map((n) => new Date(Date.now() - n * 86_400_000)).find((d) => d.getUTCDay() !== 5)!.toISOString().slice(0, 10);
  const customer = `E2E Rating ${Date.now()}`;
  const created = await api.post("/api/appointments", {
    data: {
      customer: { name: customer, phone: "+20 100 555 0155" },
      location: { area: "Maadi" },
      productCategory: "SMART_LOCK",
      visitType: "INSTALLATION",
      date: day,
      startTime: "21:30",
      durationMinutes: 30,
      technicianIds: [],
    },
  });
  expect(created.status()).toBe(201);
  const { appointment } = await created.json();
  const outcome = await api.post(`/api/appointments/${appointment.id}/outcome`, { data: { outcome: "COMPLETED", report: "Installed", version: appointment.version } });
  expect(outcome.status()).toBe(200);

  await login(page, "mona.sales@example.com");
  await page.goto("/after-sales?list=satisfaction");
  const row = page.getByRole("listitem").filter({ hasText: customer });
  await row.getByRole("radio", { name: "4 of 5 stars" }).click();
  await row.getByLabel("What the customer said").fill("Clean work, arrived on time");
  await row.getByRole("button", { name: "Save" }).click();
  await expect(page.getByText("Saved", { exact: true })).toBeVisible();
  await expect(page.getByRole("listitem").filter({ hasText: customer })).toHaveCount(0);

  // The visit page shows the rating with what the customer said.
  await page.goto(`/appointments/${appointment.id}`);
  await expect(page.getByRole("radio", { name: "4 of 5 stars" })).toHaveAttribute("aria-checked", "true");
  await expect(page.getByLabel("What the customer said")).toHaveValue("Clean work, arrived on time");
  await api.dispose();
});
