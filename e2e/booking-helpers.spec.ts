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

test("a technician picked in the booking form is held automatically and let go when the choice changes or the form is left", async ({ page, playwright }) => {
  const baseURL = test.info().project.use.baseURL!;
  const day = futureDate(310);
  await login(page, "sara.sales@example.com");
  await page.goto("/appointments/new");
  await page.getByRole("textbox", { name: "Date", exact: true }).fill(day);
  await page.getByLabel("Start time").fill("11:00");
  const row = page.getByRole("listitem").filter({ hasText: "Karim Fathy" });
  await expect(row.getByText("Available")).toBeVisible();
  await row.getByRole("checkbox").check();
  await expect(page.getByText(/Held for you until \d{2}:\d{2}/)).toBeVisible();

  const omar = await playwright.request.newContext({ baseURL });
  await omar.post("/api/auth/login", { data: { email: "omar.sales@example.com", password: PASSWORD } });
  const karim = (await technicianIds(omar)).find((t) => t.name === "Karim Fathy")!;
  const slot = { date: day, startTime: "11:30", durationMinutes: 60, technicianIds: [karim.id] };
  // Omar can neither hold nor book Karim while Sara is booking him.
  expect(await (await omar.post("/api/holds", { data: slot })).json()).toMatchObject({ ok: false });
  const refused = await omar.post("/api/appointments", { data: { customer: { name: "Colleague booking", phone: "01005550404" }, location: {}, productCategory: "INTERCOM", ...slot } });
  expect(refused.status()).toBe(422);
  expect((await refused.json()).error.fieldErrors.technicianIds).toMatch(/Karim Fathy is being held by Sara Mahmoud/);

  // Sara unticks Karim: he is free for Omar again.
  await row.getByRole("checkbox").uncheck();
  await expect.poll(async () => (await (await omar.post("/api/holds", { data: slot })).json()).ok).toBe(true);
  await omar.delete("/api/holds");

  // Sara picks him again, then leaves the form: the hold goes with her.
  await row.getByRole("checkbox").check();
  await expect(page.getByText(/Held for you until/)).toBeVisible();
  expect((await (await omar.post("/api/holds", { data: slot })).json()).ok).toBe(false);
  await page.goto("/appointments");
  await expect.poll(async () => (await (await omar.post("/api/holds", { data: slot })).json()).ok).toBe(true);
  await omar.delete("/api/holds");
  await omar.dispose();
});

test("Sales cannot book a date that has passed", async ({ page }) => {
  await login(page, "omar.sales@example.com");
  await page.goto("/appointments/new");
  await page.getByRole("textbox", { name: "Date", exact: true }).fill("2020-01-06");
  await expect(page.getByText(/This date has passed/)).toBeVisible();
});
