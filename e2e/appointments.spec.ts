import { expect, test } from "@playwright/test";
import { futureDate, login, technicianIds } from "./helpers";

test.describe("Sales booking workflow", () => {
  test("creates an appointment with two technicians, shows location details, and cancels it", async ({ page }) => {
    const name = `E2E Customer ${Date.now()}`;
    const date = futureDate();
    await login(page, "sara.sales@example.com");
    await page.goto(`/appointments/new?date=${date}`);

    await page.getByLabel("Customer full name").fill(name);
    await page.getByLabel("Primary phone").fill("+20 100 555 0101");
    await page.getByLabel("Full written address").fill("12 Road 9");
    await page.getByLabel("Area / neighbourhood").fill("Maadi");
    await page.getByLabel("Compound / building").fill("Degla Towers");
    await page.getByLabel("Apartment / unit number").fill("7A");
    await page.getByLabel("Floor number").fill("4");
    await page.getByLabel("Map link").fill("https://maps.app.goo.gl/e2eTestLink");
    await page.getByLabel("Product category").selectOption("CCTV");
    await page.getByLabel("Brand").fill("Hikvision");
    await page.getByLabel("Start time").fill("10:00");

    const techs = page.locator('[data-field="technicianIds"] label');
    await expect(techs.first()).toContainText("Available");
    await techs.nth(0).click();
    await techs.nth(1).click();
    await page.getByRole("button", { name: "Create appointment" }).click();

    await page.waitForURL(/\/appointments\/(?!new)[a-z0-9]+$/);
    await expect(page.getByRole("heading", { name })).toBeVisible();
    const openLocation = page.getByRole("link", { name: /Open Location/ }).last();
    await expect(openLocation).toHaveAttribute("href", "https://maps.app.goo.gl/e2eTestLink");
    await expect(openLocation).toHaveAttribute("target", "_blank");
    // Apartment and floor are separate fields.
    await expect(page.getByText("Apartment / unit").locator("..")).toContainText("7A");
    await expect(page.getByText("Floor", { exact: true }).locator("..")).toContainText("4");
    await expect(page.getByText("Original Sales creator").locator("..")).toContainText("Sara Mahmoud");

    // Reschedule through the edit form; the change is recorded in the history.
    await page.getByRole("link", { name: "Edit" }).click();
    await expect(page.getByLabel("Customer full name")).toHaveValue(name);
    await page.getByLabel("Start time").fill("15:30");
    await page.getByRole("button", { name: "Save changes" }).click();
    await page.waitForURL(/\/appointments\/(?!new)[a-z0-9]+$/);
    await expect(page.getByText(/^Rescheduled APT-\d{6} from .* to .*15:30/)).toBeVisible();
    await expect(page.getByText("Original Sales creator").locator("..")).toContainText("Sara Mahmoud");

    // Cancel via the dialog; the appointment stays with status Cancelled.
    await page.getByRole("button", { name: "Cancel", exact: true }).click();
    await page.getByLabel("Reason").fill("Customer travelling");
    await page.getByRole("button", { name: "Cancel appointment" }).click();
    await expect(page.getByText("This appointment is cancelled")).toBeVisible();
  });

  test("shows a server-side conflict when another user books the technician first, keeping the form data", async ({ page, request, playwright }) => {
    const date = futureDate(1);
    await login(page, "sara.sales@example.com");
    await page.goto(`/appointments/new?date=${date}`);
    const name = `Race Customer ${Date.now()}`;
    await page.getByLabel("Customer full name").fill(name);
    await page.getByLabel("Primary phone").fill("01005550202");
    await page.getByLabel("Product category").selectOption("SMART_LOCK");
    await page.getByLabel("Start time").fill("14:00");
    const firstTech = page.locator('[data-field="technicianIds"] label').first();
    await expect(firstTech).toContainText("Available");
    const techName = (await firstTech.locator("span.font-medium").first().textContent())!.trim();
    await firstTech.click();

    // Meanwhile a colleague books the same technician for an overlapping slot through the API.
    const omar = await playwright.request.newContext({ baseURL: page.url().split("/appointments")[0] });
    const loginRes = await omar.post("/api/auth/login", { data: { email: "omar.sales@example.com", password: "ChangeMe123!" } });
    expect(loginRes.ok()).toBeTruthy();
    const tech = (await technicianIds(omar)).find((t) => t.name === techName)!;
    const booked = await omar.post("/api/appointments", {
      data: {
        customer: { name: "Colleague booking", phone: "01005550303" },
        location: {},
        productCategory: "INTERCOM",
        date,
        startTime: "15:00",
        durationMinutes: 60,
        technicianIds: [tech.id],
      },
    });
    expect(booked.status()).toBe(201);
    void request;

    await page.getByRole("button", { name: "Create appointment" }).click();
    await expect(page.getByText("Scheduling conflict", { exact: true })).toBeVisible();
    await expect(page.getByRole("alert").filter({ hasText: techName })).toContainText("15:00–16:00");
    // Entered data is preserved.
    await expect(page.getByLabel("Customer full name")).toHaveValue(name);
    await expect(page).toHaveURL(/\/appointments\/new/);
    // Cancel the colleague's booking so later runs that land on the same 2031 date are not blocked by it.
    const { appointment } = await booked.json();
    expect((await omar.post(`/api/appointments/${appointment.id}/cancel`, { data: { reason: "E2E cleanup" } })).ok()).toBeTruthy();
    await omar.dispose();
  });
});

test.describe("Calendar", () => {
  test("shows appointments coloured by Sales employee with a legend and details panel", async ({ page }) => {
    await login(page, "sara.sales@example.com");
    await page.goto("/calendar?view=week");
    await expect(page.getByLabel("Sales colour legend")).toContainText("Sara Mahmoud");
    await page.getByRole("tab", { name: "Agenda" }).click();
    const first = page.locator("section ul li button").first();
    if (await first.count()) {
      await first.click();
      await expect(page.getByRole("link", { name: /Open full details/ })).toBeVisible();
    }
  });
});
