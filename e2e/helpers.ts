import { expect, type APIRequestContext, type Page } from "@playwright/test";

export const PASSWORD = process.env.SEED_PASSWORD || "ChangeMe123!";

export async function login(page: Page, email: string) {
  await page.goto("/login");
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password", { exact: true }).fill(PASSWORD);
  await page.getByRole("button", { name: "Sign in" }).click();
  await page.waitForURL((u) => !u.pathname.startsWith("/login"));
}

const DAY_MS = 86_400_000;
const isFriday = (t: number) => new Date(t).getUTCDay() === 5;

/**
 * Unique 2031 date per run so tests never collide with each other or the seed data. Counts only
 * open days: the seed closes Fridays, and a booking on one is refused.
 */
export function futureDate(offsetDays = 0) {
  let t = Date.UTC(2031, 0, 1) + Math.floor((Date.now() / 1000) % 300) * DAY_MS;
  if (isFriday(t)) t += DAY_MS;
  for (let i = 0; i < offsetDays; i++) {
    t += DAY_MS;
    if (isFriday(t)) t += DAY_MS;
  }
  return new Date(t).toISOString().slice(0, 10);
}

export async function technicianIds(request: APIRequestContext) {
  const res = await request.post("/api/appointments/availability", {
    data: { date: "2031-01-01", startTime: "00:15", durationMinutes: 15 },
  });
  expect(res.ok()).toBeTruthy();
  const body = await res.json();
  return body.technicians as { id: string; name: string }[];
}
