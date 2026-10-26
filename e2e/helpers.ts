import { expect, type APIRequestContext, type Page } from "@playwright/test";

export const PASSWORD = process.env.SEED_PASSWORD || "ChangeMe123!";

/** Signs in through the English interface (extra browser contexts do not get the config's cookie). */
export async function login(page: Page, email: string) {
  await page.context().addCookies([{ name: "ims_locale", value: "en", url: process.env.E2E_BASE_URL ?? "http://localhost:3000" }]);
  await page.goto("/login");
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password", { exact: true }).fill(PASSWORD);
  await page.getByRole("button", { name: "Sign in" }).click();
  await page.waitForURL((u) => !u.pathname.startsWith("/login"));
}

/** Unique 2031 date per run so tests never collide with each other or the seed data. */
export function futureDate(offsetDays = 0) {
  const base = Date.UTC(2031, 0, 1) + ((Date.now() / 1000) % 300) * 86_400_000;
  return new Date(base + offsetDays * 86_400_000).toISOString().slice(0, 10);
}

export async function technicianIds(request: APIRequestContext) {
  const res = await request.post("/api/appointments/availability", {
    data: { date: "2031-01-01", startTime: "00:15", durationMinutes: 15 },
  });
  expect(res.ok()).toBeTruthy();
  const body = await res.json();
  return body.technicians as { id: string; name: string }[];
}
