/**
 * Browser-side measurements against a RUNNING production build: navigation latency, main-thread
 * blocking (long tasks) while pages render, input latency in the booking form, and background
 * network traffic. Read-only (it does not submit forms).
 *
 *   BASE_URL=http://localhost:3100 CPU_THROTTLE=4 npx tsx scripts/perf/browser.ts results.json
 */
import fs from "node:fs";
import { chromium, type Page } from "playwright";

const BASE = process.env.BASE_URL ?? "http://localhost:3000";
const THROTTLE = Number(process.env.CPU_THROTTLE ?? 1);
const PASSWORD = process.env.SEED_PASSWORD || "ChangeMe123!";
const IDLE_SECONDS = Number(process.env.IDLE_SECONDS ?? 65);

type Row = { name: string; value: number; unit: string; note?: string };
const rows: Row[] = [];
const record = (name: string, value: number, unit = "ms", note?: string) => {
  rows.push({ name, value: Math.round(value), unit, note });
  console.log(`${name.padEnd(58)} ${String(Math.round(value)).padStart(7)} ${unit}${note ? `  (${note})` : ""}`);
};

/** Installs a long-task + event-timing observer that survives client-side navigations. */
const OBSERVER = `(() => {
  window.__lt = []; window.__ev = [];
  new PerformanceObserver((l) => { for (const e of l.getEntries()) window.__lt.push({ s: e.startTime, d: e.duration }); }).observe({ type: "longtask", buffered: true });
  new PerformanceObserver((l) => { for (const e of l.getEntries()) window.__ev.push({ n: e.name, d: e.duration }); }).observe({ type: "event", durationThreshold: 16, buffered: true });
})();`;

async function blocking(page: Page, since: number): Promise<{ total: number; max: number; count: number }> {
  return page.evaluate((s) => {
    const lt = (window as unknown as { __lt: { s: number; d: number }[] }).__lt.filter((x) => x.s >= s);
    return { total: lt.reduce((n, x) => n + Math.max(0, x.d - 50), 0), max: Math.max(0, ...lt.map((x) => x.d)), count: lt.length };
  }, since);
}

async function main() {
  const out = process.argv[2];
  const browser = await chromium.launch();
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  await context.addInitScript(OBSERVER);
  const page = await context.newPage();
  const cdp = await context.newCDPSession(page);
  if (THROTTLE > 1) await cdp.send("Emulation.setCPUThrottlingRate", { rate: THROTTLE });
  console.log(`Base ${BASE}, CPU throttle ${THROTTLE}x`);

  // Sign in.
  await page.goto(`${BASE}/login`);
  await page.getByLabel("Email").fill("admin@example.com");
  await page.getByLabel("Password", { exact: true }).fill(PASSWORD);
  let t = Date.now();
  await page.getByRole("button", { name: "Sign in" }).click();
  await page.waitForURL((u) => !u.pathname.startsWith("/login"));
  await page.getByRole("heading", { level: 1 }).waitFor();
  record("login -> dashboard visible", Date.now() - t);

  // Full page loads.
  for (const path of ["/", "/appointments", "/customers", "/reports", "/audit"]) {
    t = Date.now();
    await page.goto(`${BASE}${path}`, { waitUntil: "load" });
    record(`full load ${path} (load event)`, Date.now() - t);
  }

  // Client-side navigation via the sidebar: time from click to the new page's heading.
  await page.goto(`${BASE}/`, { waitUntil: "load" });
  const nav = page.getByRole("navigation", { name: "Main" });
  for (const [label, heading] of [
    ["Appointments", "Appointments"],
    ["Customers", "Customers"],
    ["Reports", "Reports"],
    ["Audit log", "Audit log"],
    ["Dashboard", /Good (morning|afternoon|evening)/],
  ] as const) {
    await page.waitForTimeout(300);
    t = Date.now();
    await nav.getByRole("link", { name: label, exact: true }).click();
    // First visual feedback = a progress indicator or loading skeleton appears, or the new page.
    await page.waitForFunction((h) => {
      if (document.querySelector("[data-nav-progress='active'], main [aria-busy='true']")) return true;
      const el = document.querySelector("main h1");
      return Boolean(el && (typeof h === "string" ? el.textContent === h : /Good (morning|afternoon|evening)/.test(el.textContent ?? "")));
    }, typeof heading === "string" ? heading : null, { polling: "raf" });
    const feedback = Date.now() - t;
    await page.getByRole("heading", { level: 1, name: heading }).waitFor();
    record(`sidebar -> ${label}: first feedback`, feedback);
    record(`sidebar -> ${label}: page ready`, Date.now() - t);
  }

  // Calendar views: time until events are drawn and main-thread blocking while rendering.
  for (const view of ["week", "month", "day", "agenda"]) {
    const since = await page.evaluate(() => performance.now());
    t = Date.now();
    await page.goto(`${BASE}/calendar?view=${view}`, { waitUntil: "load" });
    await page.waitForFunction(() => !document.querySelector('[aria-label="Loading"]'), null, { timeout: 120_000 });
    const ready = Date.now() - t;
    const b = await blocking(page, 0);
    void since;
    record(`calendar ${view}: loaded + rendered`, ready);
    record(`calendar ${view}: main thread blocked (TBT)`, b.total, "ms", `${b.count} long tasks, longest ${Math.round(b.max)} ms`);
  }
  // Switching views without reload (same data path the user clicks through).
  await page.goto(`${BASE}/calendar?view=week`, { waitUntil: "load" });
  await page.waitForFunction(() => !document.querySelector('[aria-label="Loading"]'), null, { timeout: 120_000 });
  for (const label of ["Month", "Week", "Day"]) {
    const since = await page.evaluate(() => performance.now());
    t = Date.now();
    await page.getByRole("tab", { name: label }).click();
    await page.waitForFunction(() => !document.querySelector('[aria-label="Loading"]'), null, { timeout: 120_000 });
    await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
    const b = await blocking(page, since);
    record(`calendar tab -> ${label}: done`, Date.now() - t, "ms", `blocked ${Math.round(b.total)} ms, longest task ${Math.round(b.max)} ms`);
  }
  // Opening the details panel on the month view.
  await page.getByRole("tab", { name: "Month" }).click();
  await page.waitForFunction(() => !document.querySelector('[aria-label="Loading"]'), null, { timeout: 120_000 });
  {
    const since = await page.evaluate(() => performance.now());
    t = Date.now();
    await page.locator("main [style*='background-color'] >> nth=40").click({ force: true }).catch(() => undefined);
    await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
    const b = await blocking(page, since);
    record("calendar month: click event", Date.now() - t, "ms", `blocked ${Math.round(b.total)} ms`);
  }

  // Booking form: typing latency.
  await page.goto(`${BASE}/appointments/new`, { waitUntil: "load" });
  const name = page.getByLabel("Customer full name");
  await name.click();
  const since = await page.evaluate(() => performance.now());
  t = Date.now();
  await page.keyboard.type("Mohamed Abdelrahman El-Sayed", { delay: 30 });
  const typeMs = Date.now() - t;
  const ev = await page.evaluate((s) => {
    const list = (window as unknown as { __ev: { n: string; d: number }[] }).__ev;
    void s;
    const keys = list.filter((e) => e.n.startsWith("key"));
    return { worst: Math.max(0, ...keys.map((e) => e.d)), slow: keys.length };
  }, since);
  record("booking form: type 28 chars (30 ms between keys)", typeMs, "ms", `slowest key event ${Math.round(ev.worst)} ms, ${ev.slow} key events >16 ms`);

  // Background traffic while a page is left open.
  for (const path of ["/", "/calendar?view=month"]) {
    await page.goto(`${BASE}${path}`, { waitUntil: "load" });
    await page.waitForTimeout(1500);
    let requests = 0;
    let bytes = 0;
    const onResponse = async (r: import("playwright").Response) => {
      requests++;
      try {
        bytes += (await r.body()).byteLength;
      } catch {
        /* ignore */
      }
    };
    page.on("response", onResponse);
    await page.waitForTimeout(IDLE_SECONDS * 1000);
    page.off("response", onResponse);
    record(`idle ${IDLE_SECONDS}s on ${path}: requests`, requests, "req");
    record(`idle ${IDLE_SECONDS}s on ${path}: bytes downloaded`, bytes / 1024, "KB");
  }
  const heap = await cdp.send("Runtime.getHeapUsage").catch(() => null);
  if (heap) record("JS heap used at end", heap.usedSize / 1024 / 1024, "MB");

  await browser.close();
  if (out) fs.writeFileSync(out, JSON.stringify({ base: BASE, throttle: THROTTLE, at: new Date().toISOString(), rows }, null, 2));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
