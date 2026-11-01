import { expect, test } from "@playwright/test";
import { futureDate, login, PASSWORD, technicianIds } from "./helpers";

test("a technician held by one Sales employee shows as held to another while booking", async ({ page, playwright }) => {
  const baseURL = test.info().project.use.baseURL!;
  const sara = await playwright.request.newContext({ baseURL });
  await sara.post("/api/auth/login", { data: { email: "sara.sales@example.com", password: PASSWORD } });
  const karim = (await technicianIds(sara)).find((t) => t.name === "Karim Fathy")!;
  const day = futureDate(300);
  const held = await sara.post("/api/holds", { data: { date: day, startTime: "10:00", durationMinutes: 60, technicianIds: [karim.id] } });
  expect((await held.json()).ok).toBe(true);

  await login(page, "omar.sales@example.com");
  await page.goto("/appointments/new");
  await page.getByRole("textbox", { name: "Date", exact: true }).fill(day);
  await page.getByLabel("Start time").fill("10:00");
  const row = page.getByRole("listitem").filter({ hasText: "Karim Fathy" });
  await expect(row.getByText(/Held by Sara Mahmoud until \d{2}:\d{2}/)).toBeVisible();
  await expect(row.getByRole("checkbox")).toBeDisabled();

  // Sara lets go: Karim is free again.
  await sara.delete("/api/holds");
  await page.getByLabel("Start time").fill("10:05");
  await expect(row.getByText(/Held by/)).toHaveCount(0);
  await expect(row.getByRole("checkbox")).toBeEnabled();
  await sara.dispose();
});

test("Sales cannot book a date that has passed", async ({ page }) => {
  await login(page, "omar.sales@example.com");
  await page.goto("/appointments/new");
  await page.getByRole("textbox", { name: "Date", exact: true }).fill("2020-01-06");
  await expect(page.getByText(/This date has passed/)).toBeVisible();
});
