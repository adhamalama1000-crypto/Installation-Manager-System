import { expect, test } from "@playwright/test";
import { futureDate, login, PASSWORD, technicianIds } from "./helpers";

test("the technician collects cash at the visit and the Admin receives it on the finance page", async ({ browser, playwright }) => {
  const baseURL = test.info().project.use.baseURL!;
  const day = futureDate(110);
  const sales = await playwright.request.newContext({ baseURL });
  await sales.post("/api/auth/login", { data: { email: "sara.sales@example.com", password: PASSWORD } });
  const youssef = (await technicianIds(sales)).find((t) => t.name === "Youssef Nabil")!;
  const created = await sales.post("/api/appointments", {
    data: {
      customer: { name: `E2E Payment ${Date.now()}`, phone: "+20 100 555 0144" },
      location: { area: "Heliopolis" },
      productCategory: "SMART_LOCK",
      date: day,
      startTime: "09:00",
      durationMinutes: 60,
      technicianIds: [youssef.id],
      totalPrice: 4500,
      depositAmount: 1500,
      depositMethod: "INSTAPAY",
    },
  });
  expect(created.status()).toBe(201);
  const { appointment } = await created.json();
  await sales.dispose();

  // The technician sees what to collect, not the price.
  const techPage = await (await browser.newContext({ baseURL })).newPage();
  await login(techPage, "youssef.tech@example.com");
  await techPage.goto(`/appointments/${appointment.id}`);
  await expect(techPage.getByText("To collect at the visit")).toBeVisible();
  await expect(techPage.getByText("Total price")).toHaveCount(0);
  await techPage.getByRole("radio", { name: "Done" }).click();
  await techPage.getByLabel("Visit report").fill("Installed; customer paid the rest in cash.");
  await techPage.getByLabel("Collected from the customer (EGP)").fill("3000");
  await techPage.getByLabel("Paid by").selectOption("CASH");
  await techPage.getByRole("button", { name: "Save outcome" }).click();
  await expect(techPage.getByText("Visit outcome saved")).toBeVisible();
  await expect(techPage.getByText("3,000 EGP · Cash")).toBeVisible();

  const adminPage = await (await browser.newContext({ baseURL })).newPage();
  await login(adminPage, "admin@example.com");
  await adminPage.goto(`/appointments/${appointment.id}`);
  await expect(adminPage.getByText("With Youssef Nabil")).toBeVisible();
  await adminPage.goto(`/finance?month=${day.slice(0, 7)}`);
  await expect(adminPage.getByRole("heading", { name: "Finance" })).toBeVisible();
  const holding = adminPage.getByTestId("cash-holding").filter({ hasText: "Youssef Nabil" });
  await expect(holding).toContainText(appointment.code);
  await holding.getByRole("button", { name: /^Received/ }).click();
  await expect(adminPage.getByText(/Received .* from Youssef Nabil/)).toBeVisible();
  await adminPage.goto(`/appointments/${appointment.id}`);
  await expect(adminPage.getByText("Received", { exact: true })).toBeVisible();
});
