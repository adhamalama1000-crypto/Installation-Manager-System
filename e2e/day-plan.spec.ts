import { expect, test } from "@playwright/test";
import { futureDate, login, technicianIds } from "./helpers";

test("Sales opens the day plan and gets a WhatsApp message per technician", async ({ page }) => {
  await login(page, "sara.sales@example.com");
  const ahmed = (await technicianIds(page.request)).find((t) => t.name === "Ahmed Samir")!;
  const day = futureDate(190);
  const customer = `E2E Plan ${Date.now()}`;
  const created = await page.request.post("/api/appointments", {
    data: {
      customer: { name: customer, phone: "+20 100 555 0188" },
      location: { area: "Maadi", building: "Tower 4", mapUrl: "https://maps.app.goo.gl/e2ePlan" },
      productCategory: "SMART_LOCK",
      visitType: "INSTALLATION",
      date: day,
      startTime: "11:00",
      durationMinutes: 60,
      technicianIds: [ahmed.id],
    },
  });
  expect(created.status()).toBe(201);

  await page.getByRole("link", { name: "Day plan" }).first().click();
  await expect(page.getByRole("heading", { name: "Day plan" })).toBeVisible();
  await page.goto(`/day-plan?date=${day}`);
  const card = page.getByTestId("day-plan-technician").filter({ hasText: "Ahmed Samir" });
  await expect(card).toContainText(customer);
  const link = await card.getByRole("link", { name: "WhatsApp", exact: true }).getAttribute("href");
  expect(link).toMatch(/^https:\/\/wa\.me\/201110003333\?text=/);
  const text = decodeURIComponent(link!.split("?text=")[1]!);
  expect(text).toContain("Good morning Ahmed");
  expect(text).toContain(`👤 ${customer} · 📞 +20 100 555 0188`);
  expect(text).toContain("🗺️ https://maps.app.goo.gl/e2ePlan");
  await expect(card.getByRole("link", { name: /Remind E2E on WhatsApp/ })).toHaveAttribute("href", /^https:\/\/wa\.me\/201005550188\?text=/);
});
