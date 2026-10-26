/**
 * Measures server response times and SQL work per page / API call against a RUNNING production
 * build (`npm run build && npm start`). Read-only: it signs in and issues GET requests (plus the
 * read-only availability POST). Query counts come from PostgreSQL's pg_stat_statements, so the
 * database must have that extension enabled; without it only timings are reported.
 *
 *   BASE_URL=http://localhost:3100 DATABASE_URL=".../installation_manager_perf" \
 *     npx tsx scripts/perf/measure.ts results.json
 */
import fs from "node:fs";
import { PrismaClient } from "@prisma/client";

const BASE = process.env.BASE_URL ?? "http://localhost:3000";
const RUNS = Number(process.env.RUNS ?? 7);
const PASSWORD = process.env.SEED_PASSWORD || "ChangeMe123!";
const prisma = new PrismaClient();

type Scenario = { name: string; role: string; path: string; method?: "GET" | "POST"; body?: unknown; headers?: Record<string, string> };
type Result = { name: string; role: string; status: number; medianMs: number; p95Ms: number; minMs: number; bytes: number; queries: number | null; dbMs: number | null };

async function login(email: string): Promise<string> {
  const res = await fetch(`${BASE}/api/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password: PASSWORD }),
  });
  if (!res.ok) throw new Error(`login ${email}: ${res.status} ${await res.text()}`);
  const cookie = res.headers.getSetCookie().find((c) => c.startsWith("ims_session="));
  if (!cookie) throw new Error("no session cookie");
  return cookie.split(";")[0]!;
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
     WHERE dbid = (SELECT oid FROM pg_database WHERE datname = current_database())
       AND query NOT ILIKE '%pg_stat_statements%'`,
  );
  return { queries: Number(rows[0]?.calls ?? 0), dbMs: Math.round((rows[0]?.ms ?? 0) * 10) / 10 };
}

async function hit(s: Scenario, cookie: string) {
  const t = performance.now();
  const res = await fetch(`${BASE}${s.path}`, {
    method: s.method ?? "GET",
    redirect: "manual",
    headers: { cookie, ...(s.body ? { "Content-Type": "application/json" } : {}), ...(s.headers ?? {}) },
    body: s.body ? JSON.stringify(s.body) : undefined,
  });
  const buf = await res.arrayBuffer();
  return { ms: performance.now() - t, status: res.status, bytes: buf.byteLength };
}

const pct = (xs: number[], p: number) => {
  const s = [...xs].sort((a, b) => a - b);
  return Math.round(s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))]! * 10) / 10;
};

async function main() {
  const out = process.argv[2];
  const cookies: Record<string, string> = {
    admin: await login("admin@example.com"),
    sales: await login("sara.sales@example.com"),
    tech: await login("karim.tech@example.com"),
    viewer: await login("viewer@example.com"),
  };
  const someAppt = await prisma.appointment.findFirst({ where: { startsAt: { gte: new Date() } }, orderBy: { startsAt: "asc" }, select: { id: true, customerId: true } });
  const busyCustomer = await prisma.appointment.groupBy({ by: ["customerId"], _count: { _all: true }, orderBy: { _count: { customerId: "desc" } }, take: 1 });
  const today = new Date().toISOString().slice(0, 10);
  const year = today.slice(0, 4);
  const weekFrom = today;
  const weekTo = new Date(Date.now() + 6 * 86_400_000).toISOString().slice(0, 10);
  const monthFrom = new Date(Date.now() - 7 * 86_400_000).toISOString().slice(0, 10);
  const monthTo = new Date(Date.now() + 34 * 86_400_000).toISOString().slice(0, 10);
  const rsc = { RSC: "1" };

  const scenarios: Scenario[] = [
    { name: "page /login (signed in -> redirect)", role: "admin", path: "/login" },
    { name: "page / (dashboard)", role: "admin", path: "/" },
    { name: "page / (dashboard, technician)", role: "tech", path: "/" },
    { name: "page /calendar", role: "admin", path: "/calendar" },
    { name: "page /appointments", role: "admin", path: "/appointments" },
    { name: "page /appointments (technician)", role: "tech", path: "/appointments" },
    { name: "page /appointments?q=Ahmed", role: "admin", path: "/appointments?q=Ahmed" },
    { name: "page /appointments?q=010 (phone)", role: "admin", path: "/appointments?q=010" },
    { name: "page /appointments?sort=customer", role: "admin", path: "/appointments?sort=customer&dir=asc" },
    { name: "page /appointments?page=1000 (deep)", role: "admin", path: "/appointments?page=1000" },
    { name: "page /appointments/[id]", role: "admin", path: `/appointments/${someAppt!.id}` },
    { name: "page /appointments/[id]/edit", role: "admin", path: `/appointments/${someAppt!.id}/edit` },
    { name: "page /appointments/new", role: "admin", path: "/appointments/new" },
    { name: "page /customers", role: "admin", path: "/customers" },
    { name: "page /customers?q=Ahmed", role: "admin", path: "/customers?q=Ahmed" },
    { name: "page /customers/[id] (busiest)", role: "admin", path: `/customers/${busyCustomer[0]!.customerId}` },
    { name: "page /reports (this month)", role: "admin", path: "/reports" },
    { name: "page /reports (this year)", role: "admin", path: `/reports?from=${year}-01-01&to=${year}-12-31` },
    { name: "page /users", role: "admin", path: "/users" },
    { name: "page /settings", role: "admin", path: "/settings" },
    { name: "page /audit", role: "admin", path: "/audit" },
    { name: "page /audit?q=status", role: "admin", path: "/audit?q=status" },
    { name: "page /profile", role: "admin", path: "/profile" },
    { name: "RSC nav /appointments", role: "admin", path: "/appointments", headers: rsc },
    { name: "RSC nav /customers", role: "admin", path: "/customers", headers: rsc },
    { name: "API calendar week", role: "admin", path: `/api/calendar?from=${weekFrom}&to=${weekTo}` },
    { name: "API calendar month (6 weeks)", role: "admin", path: `/api/calendar?from=${monthFrom}&to=${monthTo}` },
    { name: "API calendar month (technician)", role: "tech", path: `/api/calendar?from=${monthFrom}&to=${monthTo}` },
    { name: "API notifications (technician)", role: "tech", path: "/api/notifications" },
    { name: "API notifications (admin)", role: "admin", path: "/api/notifications" },
    { name: "API appointments list", role: "admin", path: "/api/appointments?pageSize=25" },
    { name: "API customers lookup ?q=Ahmed", role: "sales", path: "/api/customers/lookup?q=Ahmed" },
    { name: "API customers lookup ?q=0101 (phone)", role: "sales", path: "/api/customers/lookup?q=0101" },
    { name: "API availability", role: "sales", path: "/api/appointments/availability", method: "POST", body: { date: weekTo, startTime: "10:00", durationMinutes: 120 } },
    { name: "API appointments export (this year)", role: "admin", path: `/api/appointments/export?from=${year}-01-01&to=${year}-12-31` },
    { name: "API reports export appointments (this year)", role: "admin", path: `/api/reports/export?type=appointments&from=${year}-01-01&to=${year}-12-31` },
  ];

  const results: Result[] = [];
  for (const s of scenarios) {
    const cookie = cookies[s.role]!;
    await hit(s, cookie); // warm-up (JIT, connection pool, route compilation)
    await resetStats();
    const first = await hit(s, cookie);
    const stats = await readStats();
    const times = [first.ms];
    const runs = s.path.includes("export") ? 2 : RUNS - 1;
    for (let i = 0; i < runs; i++) times.push((await hit(s, cookie)).ms);
    const r: Result = {
      name: s.name,
      role: s.role,
      status: first.status,
      medianMs: pct(times, 50),
      p95Ms: pct(times, 95),
      minMs: pct(times, 0),
      bytes: first.bytes,
      queries: stats?.queries ?? null,
      dbMs: stats?.dbMs ?? null,
    };
    results.push(r);
    console.log(
      `${r.name.padEnd(46)} ${String(r.status).padStart(3)}  median ${String(r.medianMs).padStart(7)} ms  p95 ${String(r.p95Ms).padStart(7)} ms  ` +
        `${String(Math.round(r.bytes / 1024)).padStart(5)} KB  queries ${String(r.queries ?? "-").padStart(4)}  db ${String(r.dbMs ?? "-").padStart(7)} ms`,
    );
  }
  if (out) fs.writeFileSync(out, JSON.stringify({ base: BASE, runs: RUNS, at: new Date().toISOString(), results }, null, 2));
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
