import { expect, test } from "@playwright/test";
import { futureDate, login, PASSWORD, technicianIds } from "./helpers";

test("a technician records the outcome of the visit and Sales sees the report", async ({ page, playwright }) => {
  const baseURL = test.info().project.use.baseURL!;
  const sales = await playwright.request.newContext({ baseURL });
  await sales.post("/api/auth/login", { data: { email: "sara.sales@example.com", password: PASSWORD } });
  const karim = (await technicianIds(sales)).find((t) => t.name === "Karim Fathy")!;
  const name = `E2E Outcome ${Date.now()}`;
  const created = await sales.post("/api/appointments", {
    data: {
      customer: { name, phone: "+20 100 555 0199" },
      location: { area: "Maadi", mapUrl: "https://maps.app.goo.gl/e2eOutcome" },
      productCategory: "SMART_LOCK",
      visitType: "INSTALLATION",
      date: futureDate(40),
      startTime: "12:00",
      durationMinutes: 60,
      technicianIds: [karim.id],
    },
  });
  expect(created.status()).toBe(201);
  const { appointment } = await created.json();

  await login(page, "karim.tech@example.com");
  await page.goto(`/appointments/${appointment.id}`);
  await expect(page.getByText("Read-only")).toBeVisible(); // the booking itself stays read-only
  await page.getByRole("button", { name: "Start job" }).click();
  await expect(page.getByText("Job started")).toBeVisible();
  await page.getByRole("radio", { name: "Done" }).click();
  await page.getByRole("button", { name: "Save outcome" }).click();
  await expect(page.getByText(/visit report is required/)).toBeVisible();
  await page.getByLabel("Visit report").fill("Installed and paired with the customer's phone.");
  await page.getByRole("button", { name: "Save outcome" }).click();
  await expect(page.getByText("Visit outcome saved")).toBeVisible();
  await expect(page.getByText("Report by Karim Fathy")).toBeVisible();

  const seen = await (await sales.get(`/api/appointments/${appointment.id}`)).json();
  expect(seen.appointment.status.kind).toBe("COMPLETED");
  expect(seen.appointment.visitReport).toBe("Installed and paired with the customer's phone.");
  await sales.dispose();
});

test("Sales records the customer's confirmation from the details page", async ({ page }) => {
  await login(page, "sara.sales@example.com");
  const list = await (await page.request.get("/api/appointments?pageSize=50&sort=startsAt&dir=desc")).json();
  const target = (list.rows as { id: string; status: { kind: string } }[]).find((r) => r.status.kind === "SCHEDULED")!;
  await page.goto(`/appointments/${target.id}`);
  const control = page.getByLabel("Customer confirmation");
  await control.selectOption("UNREACHABLE");
  await expect(page.getByText("Customer unreachable").first()).toBeVisible();
  await expect(control).toHaveValue("UNREACHABLE");
  await control.selectOption("CONFIRMED");
  await expect(control).toHaveValue("CONFIRMED");
});
