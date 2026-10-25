import { expect, test, type APIRequestContext } from "@playwright/test";
import { futureDate, login, PASSWORD, technicianIds } from "./helpers";

async function signedIn(playwright: { request: { newContext: (o: { baseURL: string }) => Promise<APIRequestContext> } }, baseURL: string, email: string) {
  const ctx = await playwright.request.newContext({ baseURL });
  expect((await ctx.post("/api/auth/login", { data: { email, password: PASSWORD } })).ok()).toBeTruthy();
  return ctx;
}

test("a technician asks for leave, the Admin approves it and the technician can no longer be booked that day", async ({ browser, playwright }) => {
  const baseURL = test.info().project.use.baseURL!;
  const day = futureDate(70);
  const reason = `E2E check-up ${Date.now()}`;
  const admin = await signedIn(playwright, baseURL, "admin@example.com");
  try {
    const techPage = await (await browser.newContext({ baseURL })).newPage();
    await login(techPage, "mostafa.tech@example.com");
    await techPage.getByRole("link", { name: "My leave" }).first().click();
    await expect(techPage.getByRole("heading", { name: "My leave" })).toBeVisible();
    await techPage.getByLabel("Type").selectOption("SICK");
    await techPage.getByLabel("First day").fill(day);
    await techPage.getByLabel("Last day").fill(day);
    await techPage.getByLabel("Reason").fill(reason);
    await techPage.getByRole("button", { name: "Send request" }).click();
    await expect(techPage.getByText("Leave request sent to the Admins")).toBeVisible();
    await expect(techPage.getByTestId("leave-item").filter({ hasText: reason })).toContainText("Awaiting approval");

    const adminPage = await (await browser.newContext({ baseURL })).newPage();
    await login(adminPage, "admin@example.com");
    await adminPage.goto("/leaves");
    const item = adminPage.getByTestId("leave-item").filter({ hasText: reason });
    await item.getByRole("button", { name: "Approve" }).click();
    await expect(adminPage.getByText("Leave approved")).toBeVisible();
    await expect(item).toContainText("Approved");

    const sales = await signedIn(playwright, baseURL, "sara.sales@example.com");
    const mostafa = (await technicianIds(sales)).find((t) => t.name === "Mostafa Ali")!;
    const availability = await (await sales.post("/api/appointments/availability", { data: { date: day, startTime: "10:00", durationMinutes: 60 } })).json();
    expect(availability.technicians.find((t: { id: string }) => t.id === mostafa.id)).toMatchObject({ available: false, leave: { type: "SICK" } });
    const refused = await sales.post("/api/appointments", {
      data: {
        customer: { name: `E2E Leave ${Date.now()}`, phone: "+20 100 555 0177" },
        location: { area: "Zamalek" },
        productCategory: "SMART_LOCK",
        date: day,
        startTime: "10:00",
        durationMinutes: 60,
        technicianIds: [mostafa.id],
      },
    });
    expect(refused.status()).toBe(422);
    expect((await refused.json()).error.fieldErrors.technicianIds).toMatch(/Mostafa Ali is on sick leave/);
    await sales.dispose();

    // Ending the leave from the UI makes the technician bookable again.
    await item.getByRole("button", { name: "Cancel leave" }).click();
    await item.getByRole("button", { name: "Yes, cancel it" }).click();
    await expect(adminPage.getByText("Leave cancelled")).toBeVisible();
  } finally {
    // Never leave this run's leave behind: a later run on the same 2031 day would overlap it.
    const { pending, upcoming } = await (await admin.get("/api/leaves")).json();
    for (const l of [...pending, ...upcoming] as { id: string; reason: string | null }[]) {
      if (l.reason === reason) await admin.post(`/api/leaves/${l.id}/cancel`, { data: {} });
    }
    await admin.dispose();
  }
});
