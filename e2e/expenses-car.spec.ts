import { expect, test } from "@playwright/test";
import { login, PASSWORD } from "./helpers";

// 16×16 orange PNG, decoded and shrunk by the browser before upload.
const PHOTO = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAIAAACQkWg2AAAAFklEQVR4nGN4GqFMEmIY1TCqYfhqAADkpWAQ+m/KkwAAAABJRU5ErkJggg==", "base64");

test("a technician claims a taxi with the receipt and the accountant pays it", async ({ browser }) => {
  const baseURL = test.info().project.use.baseURL!;
  const tech = await (await browser.newContext({ baseURL })).newPage();
  await login(tech, "mostafa.tech@example.com");
  await tech.goto("/expenses");
  const note = `E2E taxi ${Date.now()}`;
  await tech.getByLabel("Amount (EGP)").fill("85");
  await tech.getByLabel("Note").fill(note);
  await tech.getByLabel("Receipt photo").setInputFiles({ name: "receipt.png", mimeType: "image/png", buffer: PHOTO });
  await tech.getByRole("button", { name: "Add expense" }).click();
  const row = tech.getByRole("listitem").filter({ hasText: note });
  await expect(row.getByText("Pending")).toBeVisible();
  await expect(row.getByRole("link", { name: "Receipt" })).toBeVisible();

  const accountant = await (await browser.newContext({ baseURL })).newPage();
  await login(accountant, "nadia.accounts@example.com");
  await accountant.goto("/expenses");
  const person = accountant.getByRole("listitem").filter({ hasText: "Mostafa Ali" }).filter({ has: accountant.getByRole("button", { name: "Pay" }) });
  await person.getByRole("button", { name: "Pay" }).click();
  await accountant.getByRole("dialog", { name: "Pay these expenses?" }).getByRole("button", { name: "Pay" }).click();
  await expect(accountant.getByText("Paid", { exact: true }).first()).toBeVisible();

  await tech.reload();
  await expect(tech.getByRole("listitem").filter({ hasText: note }).getByText("Paid", { exact: true })).toBeVisible();
});

test("the driver works through the day's car route and the Admin sees the car on the live board", async ({ browser, playwright }) => {
  const baseURL = test.info().project.use.baseURL!;
  const admin = await playwright.request.newContext({ baseURL });
  await admin.post("/api/auth/login", { data: { email: "admin@example.com", password: PASSWORD } });
  const today = new Intl.DateTimeFormat("en-CA", { timeZone: "Africa/Cairo" }).format(new Date());
  const customer = `E2E Car ${Date.now()}`;
  const created = await admin.post("/api/appointments", {
    data: {
      customer: { name: customer, phone: "+20 100 555 0122" },
      location: { area: "Maadi", latitude: "29.9602", longitude: "31.2569" },
      productCategory: "SMART_LOCK",
      date: today,
      startTime: "23:00",
      durationMinutes: 15,
      technicianIds: [],
      needsCar: true,
      allowClosedDay: true,
    },
  });
  expect(created.status()).toBe(201);
  await admin.dispose();

  const driverContext = await browser.newContext({ baseURL, geolocation: { latitude: 29.9602, longitude: 31.2569 }, permissions: ["geolocation"] });
  const driver = await driverContext.newPage();
  await login(driver, "driver@example.com");
  await driver.goto("/route");
  const stop = driver.getByRole("listitem").filter({ hasText: customer });
  await expect(stop).toBeVisible();
  const leave = driver.getByRole("button", { name: "Left the company" });
  if (await leave.isVisible()) await leave.click();
  await expect(driver.getByText(/Left the company at/)).toBeVisible();
  await stop.getByRole("button", { name: "Dropped the team" }).click();
  await expect(stop.getByText(/dropped \d{2}:\d{2}/)).toBeVisible();
  await stop.getByRole("button", { name: "Picked the team up" }).click();
  await expect(stop.getByText(/picked up \d{2}:\d{2}/)).toBeVisible();

  const adminPage = await (await browser.newContext({ baseURL })).newPage();
  await login(adminPage, "admin@example.com");
  await adminPage.goto("/board");
  await expect(adminPage.getByText("Company car · Tarek Driver")).toBeVisible();
});
