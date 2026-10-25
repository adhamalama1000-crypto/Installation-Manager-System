import { expect, test } from "@playwright/test";
import { futureDate, login, PASSWORD, technicianIds } from "./helpers";

test("the store hands serials to a technician, who installs one at the visit and the warranty starts", async ({ browser, playwright }) => {
  const baseURL = test.info().project.use.baseURL!;
  const run = Date.now().toString(36).toUpperCase();
  const [first, second] = [`E2E${run}A`, `E2E${run}B`];

  // Admin (same rights as the store keeper) registers a model and two serials through the API.
  const admin = await playwright.request.newContext({ baseURL });
  await admin.post("/api/auth/login", { data: { email: "admin@example.com", password: PASSWORD } });
  const model = await admin.post("/api/stock/models", { data: { name: `E2E Lock ${run}`, category: "SMART_LOCK", warrantyMonths: 24 } });
  expect(model.status()).toBe(201);
  const goodsIn = await admin.post("/api/stock", { data: { modelId: (await model.json()).id, serials: `${first.toLowerCase()}\n${second}` } });
  expect(await goodsIn.json()).toEqual({ count: 2 });

  // ...and hands both to Karim from the inventory page.
  const adminPage = await (await browser.newContext({ baseURL })).newPage();
  await login(adminPage, "admin@example.com");
  await adminPage.goto(`/inventory?q=E2E${run}`);
  await expect(adminPage.getByTestId("stock-row")).toHaveCount(2);
  await adminPage.getByLabel("Select all on this page").check();
  await adminPage.getByLabel("Move to").selectOption("WITH_TECHNICIAN");
  await adminPage.getByLabel("Technician", { exact: true }).last().selectOption({ label: "Karim Fathy" });
  await adminPage.getByRole("button", { name: "Apply" }).last().click();
  await expect(adminPage.getByText("2 items updated")).toBeVisible();
  await expect(adminPage.getByTestId("stock-row").first()).toContainText("Karim Fathy");

  const sales = await playwright.request.newContext({ baseURL });
  await sales.post("/api/auth/login", { data: { email: "sara.sales@example.com", password: PASSWORD } });
  const karim = (await technicianIds(sales)).find((t) => t.name === "Karim Fathy")!;
  const day = futureDate(150);
  const created = await sales.post("/api/appointments", {
    data: {
      customer: { name: `E2E Stock ${run}`, phone: "+20 100 555 0166" },
      location: { area: "Sheikh Zayed" },
      productCategory: "SMART_LOCK",
      date: day,
      startTime: "08:00",
      durationMinutes: 60,
      technicianIds: [karim.id],
    },
  });
  const { appointment } = await created.json();

  const techPage = await (await browser.newContext({ baseURL })).newPage();
  await login(techPage, "karim.tech@example.com");
  await techPage.goto(`/appointments/${appointment.id}`);
  await techPage.getByRole("radio", { name: "Done" }).click();
  await techPage.getByLabel("Visit report").fill("Lock installed and paired.");
  await techPage.getByRole("button", { name: `+ ${first}` }).click();
  await expect(techPage.getByLabel("Serial numbers installed")).toHaveValue(first);
  await techPage.getByRole("button", { name: "Save outcome" }).click();
  await expect(techPage.getByText("Visit outcome saved")).toBeVisible();
  const installed = techPage.getByRole("listitem").filter({ hasText: first });
  await expect(installed).toContainText(`E2E Lock ${run}`);
  await expect(installed).toContainText("Under warranty until");

  // The installed item left Karim's custody; the other one is still with him.
  await techPage.goto(`/inventory?q=E2E${run}`);
  await expect(techPage.getByRole("heading", { name: "My stock" })).toBeVisible();
  await expect(techPage.getByTestId("stock-row")).toHaveCount(1);
  await expect(techPage.getByTestId("stock-row")).toContainText(second);
  await admin.dispose();
  await sales.dispose();
});
