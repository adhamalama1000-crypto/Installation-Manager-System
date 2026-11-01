import { expect, test } from "@playwright/test";
import { login, PASSWORD, technicianIds } from "./helpers";

// A customer pin in Heliopolis and a phone standing right next to it.
const CUSTOMER = { latitude: 30.0911, longitude: 31.3225 };

test("a technician checks in at the company and through a visit with the phone's location, and the Admin sees it on the live board", async ({ browser, playwright }) => {
  const baseURL = test.info().project.use.baseURL!;
  const admin = await playwright.request.newContext({ baseURL });
  await admin.post("/api/auth/login", { data: { email: "admin@example.com", password: PASSWORD } });
  const hany = (await technicianIds(admin)).find((t) => t.name === "Youssef Nabil")!;
  // Today, early in the morning so no seeded visit clashes; the Admin may book a closed day.
  const today = new Intl.DateTimeFormat("en-CA", { timeZone: "Africa/Cairo" }).format(new Date());
  const customer = `E2E Field ${Date.now()}`;
  const created = await admin.post("/api/appointments", {
    data: {
      customer: { name: customer, phone: "+20 100 555 0133" },
      location: { area: "Heliopolis", latitude: String(CUSTOMER.latitude), longitude: String(CUSTOMER.longitude) },
      productCategory: "SMART_LOCK",
      visitType: "INSTALLATION",
      date: today,
      startTime: `0${5 + (Date.now() % 3)}:${String((Date.now() % 4) * 15).padStart(2, "0")}`,
      durationMinutes: 15,
      technicianIds: [hany.id],
      allowClosedDay: true,
    },
  });
  expect(created.status()).toBe(201);
  const { appointment } = await created.json();

  const techContext = await browser.newContext({ baseURL, geolocation: CUSTOMER, permissions: ["geolocation"] });
  const tech = await techContext.newPage();
  await login(tech, "youssef.tech@example.com");
  await tech.goto("/");
  const myDay = tech.locator("div.rounded-xl").filter({ has: tech.getByRole("heading", { name: "My day" }) });
  const companyButton = myDay.getByRole("button", { name: "I'm at the company" });
  if (await companyButton.isVisible()) {
    await companyButton.click();
    await expect(tech.getByText(/Recorded|Already recorded/).first()).toBeVisible();
  }
  await expect(myDay.getByRole("button", { name: "Leaving for the day" })).toBeEnabled();

  await tech.goto(`/appointments/${appointment.id}`);
  const panel = tech.locator("div.rounded-xl").filter({ has: tech.getByRole("heading", { name: "Check-in" }) });
  await panel.getByRole("button", { name: "On my way" }).click();
  await expect(tech.getByText(/Call the customer first/).first()).toBeVisible();
  await panel.getByRole("button", { name: "Called the customer, site ready" }).click();
  await expect(panel.getByText("Called the customer, site ready")).toBeVisible();
  await panel.getByRole("button", { name: "On my way" }).click();
  await expect(panel.getByText(/arriving around/)).toBeVisible();
  await panel.getByRole("button", { name: "Arrived at the customer" }).click();
  await expect(panel.getByText("Arrived at the customer")).toBeVisible();
  await expect(panel.getByText(/m away/)).toHaveCount(0); // standing at the pin: not flagged

  const adminPage = await (await browser.newContext({ baseURL })).newPage();
  await login(adminPage, "admin@example.com");
  await adminPage.goto("/board");
  const card = adminPage.getByRole("listitem").filter({ hasText: "Youssef Nabil" });
  await expect(card.getByText(new RegExp(`Arrived at ${customer}`))).toBeVisible();
  await adminPage.goto(`/appointments/${appointment.id}`);
  await expect(adminPage.getByRole("heading", { name: "Field log" })).toBeVisible();
  await admin.dispose();
});
