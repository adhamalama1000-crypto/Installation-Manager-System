/**
 * Concurrency test against a RUNNING production build: USERS virtual users, each with its own
 * session, request a realistic mix of pages and API calls back to back for SECONDS seconds.
 * Read-only (GET requests only).
 *
 *   BASE_URL=http://localhost:3000 USERS=20 SECONDS=30 npx tsx scripts/perf/load.ts
 */
const BASE = process.env.BASE_URL ?? "http://localhost:3000";
const USERS = Number(process.env.USERS ?? 20);
const SECONDS = Number(process.env.SECONDS ?? 30);
const PASSWORD = process.env.SEED_PASSWORD || "ChangeMe123!";
const ACCOUNTS = ["admin@example.com", "sara.sales@example.com", "karim.tech@example.com", "viewer@example.com"];

async function login(email: string) {
  const res = await fetch(`${BASE}/api/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password: PASSWORD }),
  });
  if (!res.ok) throw new Error(`login ${email}: ${res.status}`);
  return res.headers.getSetCookie().find((c) => c.startsWith("ims_session="))!.split(";")[0]!;
}

async function main() {
  const day = (offset: number) => new Date(Date.now() + offset * 86_400_000).toISOString().slice(0, 10);
  const mix = [
    "/",
    "/appointments",
    "/appointments?q=Ahmed",
    "/customers",
    "/calendar",
    `/api/calendar?from=${day(0)}&to=${day(6)}`,
    "/api/notifications",
    "/appointments?page=3",
    "/reports",
  ];
  const cookies: string[] = [];
  for (let i = 0; i < USERS; i++) cookies.push(await login(ACCOUNTS[i % ACCOUNTS.length]!));
  const latencies: number[] = [];
  let errors = 0;
  const end = Date.now() + SECONDS * 1000;
  await Promise.all(
    cookies.map(async (cookie, u) => {
      for (let i = u; Date.now() < end; i++) {
        const path = mix[i % mix.length]!;
        const t = performance.now();
        try {
          const res = await fetch(`${BASE}${path}`, { headers: { cookie, "Accept-Encoding": "gzip" }, redirect: "manual" });
          await res.arrayBuffer();
          if (res.status >= 500) errors++;
        } catch {
          errors++;
        }
        latencies.push(performance.now() - t);
      }
    }),
  );
  latencies.sort((a, b) => a - b);
  const p = (q: number) => Math.round(latencies[Math.min(latencies.length - 1, Math.floor(q * latencies.length))]!);
  console.log(
    `${USERS} users x ${SECONDS}s: ${latencies.length} requests (${(latencies.length / SECONDS).toFixed(1)}/s), ` +
      `p50 ${p(0.5)} ms, p95 ${p(0.95)} ms, p99 ${p(0.99)} ms, max ${Math.round(latencies.at(-1)!)} ms, errors ${errors}`,
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
