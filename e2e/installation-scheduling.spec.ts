import { expect, test, type APIRequestContext } from "@playwright/test";
import { PASSWORD, futureDate, login } from "./helpers";

/**
 * Installation scheduling end to end, with two technicians created for this run (so nothing here
 * changes the seeded technicians' hours):
 *   - the Installation Manager sets working hours; Sales cannot book outside them; the manager can,
 *     only with a reason; the company schedule shows the hours and the job;
 *   - a technician reads the company schedule without the other technician's customer, asks to
 *     reschedule their own job, and the manager marks the request done;
 *   - Arabic at phone width: the schedule pages read right to left and fit; the technician's
 *     dashboard lists today's jobs.
 */
const ADMIN = "admin@example.com";
const MANAGER = "installations@example.com";
const SALES = "sara.sales@example.com";

async function api(baseURL: string, email: string): Promise<APIRequestContext> {
  const { request } = await import("@playwright/test");
  const ctx = await request.newContext({ baseURL });
  expect((await ctx.post("/api/auth/login", { data: { email, password: PASSWORD } })).ok()).toBeTruthy();
  return ctx;
}

async function makeTechnician(admin: APIRequestContext, name: string) {
  const email = `${name.toLowerCase().replace(/[^a-z0-9]+/g, ".")}@e2e.local`;
  const res = await admin.post("/api/users", { data: { name, email, role: "TECHNICIAN", password: PASSWORD } });
  expect(res.status(), await res.text()).toBe(201);
  return { id: (await res.json()).user.id as string, name, email };
}

const booking = (date: string, startTime: string, technicianIds: string[], customer: string, extra: Record<string, unknown> = {}) => ({
  customer: { name: customer, phone: "+20 100 555 0199" },
  location: { area: "Nasr City", streetAddress: "5 Abbas El Akkad" },
  productCategory: "SMART_LOCK",
  visitType: "INSTALLATION",
  date,
  startTime,
  durationMinutes: 60,
  technicianIds,
  ...extra,
});

test("working hours: Sales cannot book outside them; the Installation Manager can, only with a reason", async ({ page, baseURL }) => {
  const stamp = Date.now();
  const admin = await api(baseURL!, ADMIN);
  const tech = await makeTechnician(admin, `E2E Hours ${stamp}`);
  const date = futureDate(2);
  const dayName = new Intl.DateTimeFormat("en", { weekday: "long", timeZone: "UTC" }).format(new Date(`${date}T00:00:00Z`));

  await login(page, MANAGER);
  await page.goto("/schedule/hours");
  const card = page.locator(`[data-hours="${tech.name}"]`);
  await expect(card.getByText("Not set")).toBeVisible();
  await card.getByLabel(`${dayName}, ${tech.name}`).selectOption("hours");
  await card.getByLabel(`${dayName} from`).fill("09:00");
  await card.getByLabel(`${dayName} to`).fill("12:00");
  await card.getByRole("button", { name: `Save the working hours of ${tech.name}` }).click();
  await expect(page.getByText(`Working hours of ${tech.name} saved.`)).toBeVisible();
  // A day ending before it starts is refused with the message on that day.
  await card.getByLabel(`${dayName} to`).fill("08:00");
  await card.getByRole("button", { name: `Save the working hours of ${tech.name}` }).click();
  await expect(card.getByRole("alert")).toHaveText("The end time must be after the start time.");
  await card.getByLabel(`${dayName} to`).fill("12:00");

  const sales = await api(baseURL!, SALES);
  const refused = await sales.post("/api/appointments", { data: booking(date, "14:00", [tech.id], `E2E late ${stamp}`, { overrideReason: "please" }) });
  expect(refused.status()).toBe(422);
  expect(await refused.text()).toContain("works 09:00–12:00");

  const m = await api(baseURL!, MANAGER);
  const avail = await m.post("/api/appointments/availability", { data: { date, startTime: "14:00", durationMinutes: 60 } });
  const mine = ((await avail.json()).technicians as { id: string; offHours: string | null }[]).find((x) => x.id === tech.id);
  expect(mine?.offHours).toBe("outsideHours");
  const noReason = await m.post("/api/appointments", { data: booking(date, "14:00", [tech.id], `E2E late ${stamp}`) });
  expect(noReason.status()).toBe(422);
  expect(JSON.stringify(await noReason.json())).toContain("overrideReason");
  const ok = await m.post("/api/appointments", { data: booking(date, "14:00", [tech.id], `E2E late ${stamp}`, { overrideReason: "Customer only free after 2 pm" }) });
  expect(ok.status(), await ok.text()).toBe(201);
  const code = (await ok.json()).appointment.code as string;

  // The company schedule shows the hours, the job and the workload for that day.
  await page.goto(`/schedule?view=day&date=${date}&technicianId=${tech.id}`);
  const row = page.locator(`[data-technician="${tech.name}"]`);
  await expect(row.getByText("09:00–12:00")).toBeVisible();
  await expect(row.locator(`[data-job="${code}"]`)).toContainText(`E2E late ${stamp}`);

  // The booking form offers the override reason when a chosen technician is outside their hours.
  await page.goto(`/appointments/new?date=${date}&time=15:30`);
  await page.getByLabel(new RegExp(`^${tech.name}`)).check();
  await expect(page.getByText("Outside working hours").first()).toBeVisible();
  await expect(page.getByLabel(/Reason for overriding the schedule/)).toBeVisible();
  await admin.dispose();
  await sales.dispose();
  await m.dispose();
});

test("a technician reads the company schedule without other customers and asks to reschedule; the manager marks it done", async ({ browser, baseURL }) => {
  const stamp = Date.now();
  const admin = await api(baseURL!, ADMIN);
  const a = await makeTechnician(admin, `E2E Asker ${stamp}`);
  const b = await makeTechnician(admin, `E2E Other ${stamp}`);
  const date = futureDate(3);
  const own = await admin.post("/api/appointments", { data: booking(date, "10:00", [a.id], `E2E Mine ${stamp}`) });
  expect(own.status(), await own.text()).toBe(201);
  const ownId = (await own.json()).appointment.id as string;
  const other = await admin.post("/api/appointments", { data: booking(date, "11:00", [b.id], `E2E Hidden ${stamp}`, { visitType: "REMOVAL" }) });
  expect(other.status()).toBe(201);

  const techPage = await (await browser.newContext({ baseURL })).newPage();
  await login(techPage, a.email);
  await techPage.goto(`/schedule?view=day&date=${date}`);
  await expect(techPage.locator(`[data-technician="${a.name}"]`)).toContainText(`E2E Mine ${stamp}`);
  const otherRow = techPage.locator(`[data-technician="${b.name}"]`);
  await expect(otherRow).toContainText("Removal");
  await expect(otherRow).toContainText("Customer details hidden");
  await expect(techPage.getByText(`E2E Hidden ${stamp}`)).toHaveCount(0);
  // Read-only: no booking or hours controls for a technician.
  await expect(techPage.getByRole("link", { name: "Working hours" })).toHaveCount(0);
  expect((await techPage.request.put(`/api/work-hours/${a.id}`, { data: { days: [] } })).status()).toBe(403);

  await techPage.goto(`/appointments/${ownId}`);
  await techPage.getByRole("button", { name: "Ask to reschedule" }).click();
  const dialog = techPage.getByRole("dialog", { name: "Ask to reschedule" });
  await dialog.getByLabel("Why should this visit move?").fill("The customer asked for the afternoon");
  await dialog.getByRole("button", { name: "Send request" }).click();
  await expect(techPage.getByText(/Request sent/)).toBeVisible();
  await expect(techPage.getByRole("button", { name: "Ask to reschedule" })).toHaveCount(0);

  const manager = await (await browser.newContext({ baseURL })).newPage();
  await login(manager, MANAGER);
  await manager.goto("/schedule");
  const item = manager.locator("[data-reschedule]").filter({ hasText: "The customer asked for the afternoon" });
  await expect(item).toBeVisible();
  await item.getByRole("button", { name: "Mark done" }).click();
  await manager.getByRole("dialog", { name: /Mark the request for/ }).getByRole("button", { name: "Mark done" }).click();
  await expect(manager.getByText("Request marked done.")).toBeVisible();
  await techPage.goto(`/appointments/${ownId}`);
  await expect(techPage.getByText(/Done by Ihab Installations/)).toBeVisible();
  await admin.dispose();
});

test.describe("Arabic, phone", () => {
  test.use({ viewport: { width: 390, height: 844 } });

  test("the schedule pages read right to left and fit a phone; the technician sees today's jobs", async ({ browser, baseURL }) => {
    const stamp = Date.now();
    const admin = await api(baseURL!, ADMIN);
    const tech = await makeTechnician(admin, `E2E Today ${stamp}`);
    const today = new Intl.DateTimeFormat("en-CA", { timeZone: "Africa/Cairo" }).format(new Date());
    const job = await admin.post("/api/appointments", { data: booking(today, "23:30", [tech.id], `E2E Today ${stamp}`, { durationMinutes: 15, overrideReason: "e2e: today may be a closed day" }) });
    expect(job.status(), await job.text()).toBe(201);

    const signIn = async (email: string) => {
      const page = await (await browser.newContext({ baseURL, viewport: { width: 390, height: 844 } })).newPage();
      await page.context().addCookies([{ name: "ims_locale", value: "ar", url: baseURL! }]);
      await page.goto("/login");
      await page.locator('input[type="email"]').fill(email);
      await page.locator('input[autocomplete="current-password"]').fill(PASSWORD);
      await page.getByRole("button", { name: "تسجيل الدخول" }).click();
      await page.waitForURL((u) => !u.pathname.startsWith("/login"));
      return page;
    };
    const fits = async (page: Awaited<ReturnType<typeof signIn>>, path: string) => {
      await page.goto(path);
      await expect(page.locator("html")).toHaveAttribute("dir", "rtl");
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
      expect(overflow, path).toBeLessThanOrEqual(1);
    };
    const manager = await signIn(MANAGER);
    for (const path of ["/schedule", "/schedule?view=week", "/schedule?view=month", "/schedule/hours"]) await fits(manager, path);
    await manager.goto("/schedule");
    await expect(manager.getByRole("heading", { name: "جدول الشركة" })).toBeVisible();

    const techPage = await signIn(tech.email);
    await fits(techPage, "/");
    await expect(techPage.getByText("شغلي النهارده")).toBeVisible();
    await expect(techPage.locator("[data-job]").filter({ hasText: `E2E Today ${stamp}` })).toBeVisible();
    await fits(techPage, "/schedule?view=week");
    await admin.dispose();
  });
});
