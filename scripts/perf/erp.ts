/**
 * ERP measurements against a RUNNING production build (`npm run build && npm start`), the same
 * procedure before and after a change:
 *
 *  1. Server: median / p95 response time, bytes and SQL statements (pg_stat_statements, when the
 *     database has it) for the dashboard, the inventory pages, product search and detail, the
 *     inventory APIs and the reports, both as a full page (HTML) and as the RSC payload that a
 *     client-side navigation fetches (header `RSC: 1`).
 *  2. Browser: Chromium signs in, then clicks through the sidebar Dashboard → Stock on hand →
 *     Products → a product → Stock documents → Stock ledger → Warehouses → Dashboard, ROUNDS
 *     times, and records the time from the click until the new page's heading is on screen
 *     (median and worst per step), plus the first full load of the app.
 *
 * Read-only: it signs in and issues GET requests only.
 *
 *   BASE_URL=http://localhost:3100 DATABASE_URL=".../installation_manager_perf" \
 *     npx tsx scripts/perf/erp.ts docs/performance/erp-before.json
 *   CPU_THROTTLE=4 adds browser CPU throttling; SKIP_BROWSER=1 / SKIP_SERVER=1 run one half.
 */
import fs from "node:fs";
import { PrismaClient } from "@prisma/client";
import { chromium } from "playwright";

const BASE = process.env.BASE_URL ?? "http://localhost:3000";
const RUNS = Number(process.env.RUNS ?? 9);
const ROUNDS = Number(process.env.ROUNDS ?? 7);
const THROTTLE = Number(process.env.CPU_THROTTLE ?? 1);
const PASSWORD = process.env.SEED_PASSWORD || "ChangeMe123!";
const prisma = new PrismaClient();

type Scenario = { name: string; role: "admin" | "warehouse" | "tech"; path: string; rsc?: boolean };

async function login(email: string): Promise<string> {
  const res = await fetch(`${BASE}/api/auth/login`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email, password: PASSWORD }) });
  if (!res.ok) throw new Error(`login ${email}: ${res.status} ${await res.text()}`);
  const cookie = res.headers.getSetCookie().find((c) => c.startsWith("ims_session="));
  if (!cookie) throw new Error("no session cookie");
  return `${cookie.split(";")[0]!}; ims_locale=en`;
}

let statsAvailable = true;
async function resetStats() {
  if (!statsAvailable) return;
  try {
    await prisma.$executeRawUnsafe("SELECT pg_stat_statements_reset(0, 0, 0)");
  } catch {
    statsAvailable = false;
  }
}
async function readStats(): Promise<{ queries: number; dbMs: number } | null> {
  if (!statsAvailable) return null;
  const rows = await prisma.$queryRawUnsafe<{ calls: bigint | null; ms: number | null }[]>(
    `SELECT SUM(calls)::bigint AS calls, SUM(total_exec_time)::float8 AS ms FROM pg_stat_statements
     WHERE dbid = (SELECT oid FROM pg_database WHERE datname = current_database()) AND query NOT ILIKE '%pg_stat_statements%'`,
  );
  return { queries: Number(rows[0]?.calls ?? 0), dbMs: Math.round((rows[0]?.ms ?? 0) * 10) / 10 };
}

async function hit(s: Scenario, cookie: string) {
  const t = performance.now();
  // A client-side navigation fetches the page's RSC payload: header `RSC: 1` and an `_rsc` query.
  const url = s.rsc ? `${BASE}${s.path}${s.path.includes("?") ? "&" : "?"}_rsc` : `${BASE}${s.path}`;
  const res = await fetch(url, { redirect: "manual", headers: { cookie, "accept-encoding": "gzip", ...(s.rsc ? { RSC: "1" } : {}) } });
  const buf = await res.arrayBuffer();
  return { ms: performance.now() - t, status: res.status, bytes: buf.byteLength };
}

const pct = (xs: number[], p: number) => {
  const s = [...xs].sort((a, b) => a - b);
  return Math.round(s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))]! * 10) / 10;
};

async function server() {
  const cookies = { admin: await login("admin@example.com"), warehouse: await login("warehouse@example.com").catch(() => ""), tech: await login("karim.tech@example.com").catch(() => "") };
  const product = await prisma.product.findFirst({ where: { trackSerials: true }, orderBy: { sku: "asc" }, select: { id: true } });
  const warehouse = await prisma.warehouse.findFirst({ where: { code: "MAIN" }, select: { id: true } });
  const doc = await prisma.stockDocument.findFirst({ orderBy: { createdAt: "desc" }, select: { id: true } });
  const year = new Date().toISOString().slice(0, 4);
  const pages: [string, string][] = [
    ["dashboard", "/"],
    ["stock on hand", "/stock"],
    ["stock by warehouse", "/stock?view=location"],
    ["stock low only", "/stock?low=1"],
    ["stock documents", "/stock/documents"],
    ["stock ledger", "/stock/movements"],
    ["products", "/products"],
    ["products search 'camera'", "/products?q=camera"],
    ["products search SKU", "/products?q=PRF-0150"],
    ["product detail", `/products/${product?.id}`],
    ["warehouses", "/warehouses"],
    ["warehouse detail", `/warehouses/${warehouse?.id}`],
    ["stock document detail", `/stock/documents/${doc?.id}`],
    ["stocktakes", "/stocktakes"],
    ["reports (this year)", `/reports?from=${year}-01-01&to=${year}-12-31`],
    ["appointments", "/appointments"],
  ];
  const scenarios: Scenario[] = [
    ...pages.map(([n, p]) => ({ name: `page ${n}`, role: "admin" as const, path: p })),
    ...pages.map(([n, p]) => ({ name: `RSC nav ${n}`, role: "admin" as const, path: p, rsc: true })),
    { name: "RSC nav stock (technician van)", role: "tech", path: "/stock", rsc: true },
    { name: "API products ?q=lock", role: "admin", path: "/api/products?q=lock" },
    { name: "API products page 50", role: "admin", path: "/api/products?page=50" },
    { name: "API products picker (warehouse)", role: "admin", path: `/api/products?q=hik&warehouseId=${warehouse?.id}` },
    { name: "API product detail", role: "admin", path: `/api/products/${product?.id}` },
    { name: "API inventory balances", role: "admin", path: "/api/inventory/balances" },
    { name: "API inventory ledger", role: "admin", path: "/api/inventory/ledger" },
    { name: "API availability", role: "admin", path: `/api/inventory/availability?warehouseId=${warehouse?.id}&productId=${product?.id}` },
    { name: "API balances CSV export", role: "admin", path: "/api/inventory/export?kind=balances" },
  ];
  const results = [];
  for (const s of scenarios) {
    const cookie = cookies[s.role];
    if (!cookie) continue;
    for (let i = 0; i < 3; i++) await hit(s, cookie); // warm-up: JIT, pool, prepared statements
    await resetStats();
    const first = await hit(s, cookie);
    const stats = await readStats();
    const times = [first.ms];
    for (let i = 0; i < (s.path.includes("export") ? 2 : RUNS - 1); i++) times.push((await hit(s, cookie)).ms);
    const r = { name: s.name, status: first.status, medianMs: pct(times, 50), p95Ms: pct(times, 95), bytes: first.bytes, queries: stats?.queries ?? null, dbMs: stats?.dbMs ?? null };
    results.push(r);
    console.log(`${r.name.padEnd(42)} ${String(r.status).padStart(3)}  median ${String(r.medianMs).padStart(7)} ms  p95 ${String(r.p95Ms).padStart(7)} ms  ${String(Math.round(r.bytes / 1024)).padStart(5)} KB  queries ${String(r.queries ?? "-").padStart(4)}  db ${String(r.dbMs ?? "-").padStart(6)} ms`);
  }
  return results;
}

async function browser() {
  const b = await chromium.launch();
  const context = await b.newContext({ viewport: { width: 1440, height: 900 } });
  await context.addCookies([{ name: "ims_locale", value: "en", url: BASE }]);
  const page = await context.newPage();
  if (THROTTLE > 1) await (await context.newCDPSession(page)).send("Emulation.setCPUThrottlingRate", { rate: THROTTLE });
  const rows: { name: string; medianMs: number; maxMs: number; samples: number[] }[] = [];

  await page.goto(`${BASE}/login`);
  await page.getByLabel("Email").fill("admin@example.com");
  await page.getByLabel("Password", { exact: true }).fill(PASSWORD);
  let t = Date.now();
  await page.getByRole("button", { name: "Sign in" }).click();
  await page.waitForURL((u) => !u.pathname.startsWith("/login"));
  await page.locator("main h1").first().waitFor();
  const loginMs = Date.now() - t;
  t = Date.now();
  await page.goto(`${BASE}/stock`, { waitUntil: "load" });
  const fullLoadStock = Date.now() - t;

  const nav = page.getByRole("navigation", { name: "Main" });
  const steps: { name: string; go: () => Promise<void>; url: RegExp; heading: RegExp }[] = [
    { name: "Dashboard → Stock on hand", go: () => nav.getByRole("link", { name: "Stock on hand", exact: true }).click(), url: /\/stock$/, heading: /Stock on hand/ },
    { name: "Stock → Products", go: () => nav.getByRole("link", { name: "Products", exact: true }).click(), url: /\/products$/, heading: /^Products$/ },
    { name: "Products → product detail", go: () => page.locator("main table tbody a[href^='/products/']").first().click(), url: /\/products\/[^/]+$/, heading: /./ },
    { name: "Product → Stock documents", go: () => nav.getByRole("link", { name: "Stock documents", exact: true }).click(), url: /\/stock\/documents$/, heading: /Stock documents/ },
    { name: "Documents → Stock ledger", go: () => nav.getByRole("link", { name: "Stock ledger", exact: true }).click(), url: /\/stock\/movements$/, heading: /ledger/i },
    { name: "Ledger → Warehouses", go: () => nav.getByRole("link", { name: "Warehouses", exact: true }).click(), url: /\/warehouses$/, heading: /Warehouses/ },
    { name: "Warehouses → Dashboard", go: () => nav.getByRole("link", { name: "Dashboard", exact: true }).click(), url: /\/$/, heading: /./ },
  ];
  // Timed inside the page: from the click event's timestamp to the first animation frame in
  // which the new page's heading is on screen and no loading skeleton is left (Playwright's own
  // waiting re-checks at 20 / 50 / 100 / 500 ms steps, which would round the times up).
  const samples = new Map<string, number[]>();
  const prefetches: number[] = [];
  let rscCount = 0;
  page.on("request", (r) => {
    if (r.url().includes("_rsc=") && r.headers()["next-router-prefetch"]) rscCount++;
  });
  await page.goto(`${BASE}/`, { waitUntil: "load" });
  for (let r = 0; r < ROUNDS; r++) {
    for (const s of steps) {
      await page.waitForTimeout(600);
      // A string, not a function: tsx would add helpers the page does not have.
      await page.evaluate(`(() => {
        const heading = new RegExp(${JSON.stringify(s.heading.source)}, ${JSON.stringify(s.heading.flags)});
        window.__nav = new Promise((resolve) => {
          let clickAt = 0;
          const start = location.href;
          document.addEventListener("click", (e) => (clickAt = e.timeStamp), { capture: true, once: true });
          const tick = () => {
            const h = document.querySelector("main h1");
            if (clickAt && location.href !== start && h && heading.test(h.textContent || "") && !document.querySelector("main [aria-busy='true']")) resolve(performance.now() - clickAt);
            else requestAnimationFrame(tick);
          };
          requestAnimationFrame(tick);
        });
      })()`);
      const before = rscCount;
      await s.go();
      const ms = Math.round(Number(await page.evaluate("window.__nav")));
      await page.waitForURL((u) => s.url.test(u.pathname));
      await page.waitForTimeout(1500); // let the prefetches this page starts finish, then count them
      if (r > 0) {
        (samples.get(s.name) ?? samples.set(s.name, []).get(s.name)!).push(ms); // round 0 warms up
        prefetches.push(rscCount - before);
      }
    }
  }
  console.log(`\nBrowser (CPU ${THROTTLE}x): sign-in → dashboard ${loginMs} ms, full load /stock ${fullLoadStock} ms`);
  for (const s of steps) {
    const xs = samples.get(s.name)!;
    const row = { name: s.name, medianMs: pct(xs, 50), maxMs: Math.max(...xs), samples: xs };
    rows.push(row);
    console.log(`${s.name.padEnd(36)} median ${String(row.medianMs).padStart(6)} ms  worst ${String(row.maxMs).padStart(6)} ms`);
  }
  const all = rows.flatMap((r) => r.samples);
  const prefetchPerNav = Math.round(prefetches.reduce((a, b) => a + b, 0) / Math.max(1, prefetches.length));
  console.log(`${"All sidebar navigations".padEnd(36)} median ${String(pct(all, 50)).padStart(6)} ms  p95 ${String(pct(all, 95)).padStart(6)} ms`);
  console.log(`${"Prefetch requests per navigation".padEnd(36)} ${prefetchPerNav}`);
  await b.close();
  return { throttle: THROTTLE, loginMs, fullLoadStock, steps: rows, allMedianMs: pct(all, 50), allP95Ms: pct(all, 95), prefetchPerNav };
}

async function main() {
  const out = process.argv[2];
  const result: Record<string, unknown> = { base: BASE, at: new Date().toISOString(), runs: RUNS, rounds: ROUNDS };
  if (!process.env.SKIP_SERVER) result.server = await server();
  if (!process.env.SKIP_BROWSER) result.browser = await browser();
  if (out) fs.writeFileSync(out, JSON.stringify(result, null, 2));
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
