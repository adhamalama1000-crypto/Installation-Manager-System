/**
 * Sign-in abuse resistance through the real login route: atomic limits under concurrency, spoofed
 * forwarding headers, several app instances sharing the database, database failure, a saturated
 * password pool, bounded audit entries, and no account enumeration or secrets in the records.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PrismaClient } from "@prisma/client";
import { POST as login } from "@/app/api/auth/login/route";
import { hashPassword } from "@/server/auth/password";
import { resetHashPoolForTests } from "@/server/auth/hash-pool";
import { purgeOldLoginAttempts, reserveLoginAttempt, resetCleanupScheduleForTests } from "@/server/auth/rate-limit";
import { accountAddressKey, accountKey, addressKey, loginLimits } from "@/lib/login-limits";
import { makeUser, prisma, resetDb } from "../helpers";

const PASSWORD = "Password123";
const WRONG = "Wrong-Password-9";

function loginReq(email: string, password: string, headers: Record<string, string> = {}) {
  return new Request("http://localhost:3000/api/auth/login", {
    method: "POST",
    headers: { host: "localhost:3000", "content-type": "application/json", "user-agent": "limits-test", ...headers },
    body: JSON.stringify({ email, password }),
  });
}
const statuses = (rs: Response[]) => rs.reduce<Record<number, number>>((m, r) => ((m[r.status] = (m[r.status] ?? 0) + 1), m), {});
const audits = (action: string) => prisma.auditLog.count({ where: { action } });

const ENV = ["TRUSTED_PROXY_HOPS", "LOGIN_MAX_FAILURES_PER_ACCOUNT", "LOGIN_MAX_FAILURES_PER_ACCOUNT_TOTAL", "LOGIN_MAX_FAILURES_PER_IP", "LOGIN_MAX_FAILURES_GLOBAL_PER_MINUTE", "AUTH_HASH_THREADS", "AUTH_HASH_MAX_QUEUE", "AUTH_HASH_QUEUE_TIMEOUT_MS", "AUTH_HASH_MAX_PER_CLIENT", "AUTH_HASH_PRIORITY_RESERVE"];
let hash: string;

/** Limits use fixed windows (1 and 15 minutes); start each test well inside one so it cannot straddle two. */
async function awayFromWindowEdge() {
  const left = (minutes: number) => minutes * 60_000 - (Date.now() % (minutes * 60_000));
  const wait = Math.min(left(1), left(15));
  if (wait < 15_000) await new Promise((r) => setTimeout(r, wait + 200));
}

beforeEach(async () => {
  for (const k of ENV) delete process.env[k];
  await resetHashPoolForTests();
  resetCleanupScheduleForTests();
  await resetDb();
  hash ??= await hashPassword(PASSWORD);
  await makeUser("SALES", { email: "victim@test.local", passwordHash: hash });
  await makeUser("SALES", { email: "other@test.local", passwordHash: hash });
  await awayFromWindowEdge();
});
afterEach(async () => {
  vi.restoreAllMocks();
  for (const k of ENV) delete process.env[k];
  await resetHashPoolForTests();
});

describe("per-account limit", () => {
  it("lets exactly 5 of 100 simultaneous wrong-password requests reach the password check", async () => {
    const rs = await Promise.all(Array.from({ length: 100 }, () => login(loginReq("victim@test.local", WRONG))));
    expect(statuses(rs)).toEqual({ 401: 5, 429: 95 });
    expect(await prisma.loginAttempt.count({ where: { email: "victim@test.local" } })).toBe(5);
    expect(await audits("LOGIN_FAILED")).toBe(5);
    expect(await audits("LOGIN_BLOCKED")).toBe(1); // one entry, not 95
    const blocked = rs.find((r) => r.status === 429)!;
    expect(Number(blocked.headers.get("retry-after"))).toBeGreaterThan(0);
    // Even the right password is refused until the window ends.
    expect((await login(loginReq("victim@test.local", PASSWORD))).status).toBe(429);
    // Other accounts are not affected.
    expect((await login(loginReq("other@test.local", PASSWORD))).status).toBe(200);
  });

  it("cannot be bypassed with spoofed X-Forwarded-For (no trusted proxy)", async () => {
    const rs = await Promise.all(Array.from({ length: 40 }, (_, i) => login(loginReq("victim@test.local", WRONG, { "x-forwarded-for": `10.0.${i}.1`, "x-real-ip": `10.1.${i}.1` }))));
    expect(statuses(rs)).toEqual({ 401: 5, 429: 35 });
    // The spoofed addresses are recorded nowhere as the client address.
    expect(await prisma.loginAttempt.findMany({ distinct: ["ipAddress"], select: { ipAddress: true } })).toEqual([{ ipAddress: "unknown" }]);
  });

  it("holds for the same account from many real addresses (behind a trusted proxy): 10 in total", async () => {
    process.env.TRUSTED_PROXY_HOPS = "1";
    // Each address has 5 attempts at the account, the account 10 across all addresses
    // (LOGIN_MAX_FAILURES_PER_ACCOUNT_TOTAL), so changing address does not buy more guesses.
    const rs = await Promise.all(Array.from({ length: 20 }, (_, i) => login(loginReq("victim@test.local", WRONG, { "x-forwarded-for": `198.51.100.${i + 1}` }))));
    expect(statuses(rs)).toEqual({ 401: 10, 429: 10 });
  });

  it("is cleared by a successful sign-in, and treats unknown emails exactly like real ones", async () => {
    for (let i = 0; i < 4; i++) expect((await login(loginReq("victim@test.local", WRONG))).status).toBe(401);
    expect((await login(loginReq("victim@test.local", PASSWORD))).status).toBe(200);
    expect(await prisma.authRateLimit.count({ where: { key: accountKey("victim@test.local") } })).toBe(0);
    for (let i = 0; i < 5; i++) expect((await login(loginReq("victim@test.local", WRONG))).status).toBe(401);

    // An unknown email: same answers, same lockout point, same headers.
    const known: Response[] = [];
    const unknown: Response[] = [];
    for (let i = 0; i < 6; i++) {
      known.push(await login(loginReq("other@test.local", WRONG)));
      unknown.push(await login(loginReq("nobody@test.local", WRONG)));
    }
    expect(known.map((r) => r.status)).toEqual([401, 401, 401, 401, 401, 429]);
    expect(unknown.map((r) => r.status)).toEqual(known.map((r) => r.status));
    expect(await unknown[0]!.json()).toEqual(await known[0]!.json());
    expect(await unknown[5]!.json()).toEqual(await known[5]!.json());
    expect([...unknown[0]!.headers.keys()].sort()).toEqual([...known[0]!.headers.keys()].sort());
  });
});

describe("per-address limit (trusted proxy only)", () => {
  it("blocks one address after 30 failures across different accounts, whatever the client puts in front", async () => {
    process.env.TRUSTED_PROXY_HOPS = "1";
    process.env.AUTH_HASH_MAX_QUEUE = "100";
    process.env.AUTH_HASH_QUEUE_TIMEOUT_MS = "60000"; // let all 30 admitted checks queue (the default refuses some with 503)
    // This test is about the address counter; the pool's own per-client cap (2 at a time, tested in
    // login-availability.test.ts) would answer most of these 60 simultaneous requests with 503.
    process.env.AUTH_HASH_MAX_PER_CLIENT = "0";
    // The client rotates the left part; the proxy-appended address (rightmost) stays the same.
    const rs = await Promise.all(Array.from({ length: 60 }, (_, i) => login(loginReq(`user${i}@test.local`, WRONG, { "x-forwarded-for": `6.6.${i}.6, 203.0.113.9` }))));
    expect(statuses(rs)).toEqual({ 401: 30, 429: 30 });
    expect(await prisma.auditLog.count({ where: { action: "LOGIN_BLOCKED", entityId: addressKey("203.0.113.9") } })).toBe(1);
    // A different address is fine.
    expect((await login(loginReq("other@test.local", PASSWORD, { "x-forwarded-for": "203.0.113.10" }))).status).toBe(200);
    // Refused requests gave back their account slots: user0..59 have at most one count each.
    const accounts = await prisma.authRateLimit.findMany({ where: { key: { startsWith: "acct:" } } });
    expect(accounts.reduce((n, a) => n + a.count, 0)).toBe(30);
  });

  it("is not applied to the shared 'unknown' address, so one client cannot lock everybody out", async () => {
    await Promise.all(Array.from({ length: 40 }, (_, i) => login(loginReq(`user${i}@test.local`, WRONG))));
    expect((await login(loginReq("other@test.local", PASSWORD))).status).toBe(200);
  });
});

describe("global limit", () => {
  it("caps failures per minute across all accounts and addresses, auditing it once", async () => {
    process.env.LOGIN_MAX_FAILURES_GLOBAL_PER_MINUTE = "20";
    process.env.AUTH_HASH_MAX_QUEUE = "100";
    process.env.AUTH_HASH_QUEUE_TIMEOUT_MS = "60000";
    const rs = await Promise.all(Array.from({ length: 50 }, (_, i) => login(loginReq(`spray${i}@test.local`, WRONG))));
    expect(statuses(rs)).toEqual({ 401: 20, 429: 30 });
    expect(await prisma.auditLog.count({ where: { action: "LOGIN_BLOCKED", entityId: "global" } })).toBe(1);
    expect(await prisma.loginAttempt.count()).toBe(20);
  });
});

describe("several app instances sharing the database", () => {
  it("count together: 3 connection pools x 40 simultaneous reservations give exactly 5 slots", async () => {
    const instances = [prisma, new PrismaClient(), new PrismaClient()];
    try {
      // No trusted address: the account counter alone decides (a known address is checked first and
      // has its own limit, covered below).
      const results = await Promise.all(instances.flatMap((db) => Array.from({ length: 40 }, () => reserveLoginAttempt("victim@test.local", "unknown", { db }))));
      expect(results.filter((r) => r.ok)).toHaveLength(5);
      expect(results.filter((r) => !r.ok && r.firstBlock)).toHaveLength(1);
      const row = await prisma.authRateLimit.findFirstOrThrow({ where: { key: accountKey("victim@test.local") } });
      expect(row.count).toBe(120);
    } finally {
      await Promise.all(instances.slice(1).map((c) => c.$disconnect()));
    }
  });

  it("count together for one account from one trusted address: exactly 5 slots", async () => {
    const instances = [prisma, new PrismaClient(), new PrismaClient()];
    try {
      const results = await Promise.all(instances.flatMap((db) => Array.from({ length: 10 }, () => reserveLoginAttempt("victim@test.local", "203.0.113.5", { db }))));
      expect(results.filter((r) => r.ok)).toHaveLength(5);
      expect(results.filter((r) => !r.ok && r.scope === "account" && r.firstBlock)).toHaveLength(1);
      const row = await prisma.authRateLimit.findFirstOrThrow({ where: { key: accountAddressKey("victim@test.local", "203.0.113.5") } });
      expect(row.count).toBe(30); // refused requests keep counting against the (account, address) pair
    } finally {
      await Promise.all(instances.slice(1).map((c) => c.$disconnect()));
    }
  });

  it("and the address and global counters stay exact under concurrency", async () => {
    const limits = { ...loginLimits(), perAccount: 1000, perAddress: 50, globalPerMinute: 1000 };
    const extra = new PrismaClient();
    try {
      const results = await Promise.all(Array.from({ length: 120 }, (_, i) => reserveLoginAttempt(`a${i}@test.local`, "203.0.113.5", { limits, db: i % 2 ? extra : prisma })));
      expect(results.filter((r) => r.ok)).toHaveLength(50);
      const rows = Object.fromEntries((await prisma.authRateLimit.findMany()).filter((r) => !r.key.startsWith("acct:")).map((r) => [r.key, r.count]));
      expect(rows[addressKey("203.0.113.5")]).toBe(120); // refused requests keep counting against the address
      expect(rows.global).toBe(50); // ...but gave back their global slot
      const accounts = await prisma.authRateLimit.aggregate({ where: { key: { startsWith: "acct:" } }, _sum: { count: true } });
      expect(accounts._sum.count).toBe(50);
    } finally {
      await extra.$disconnect();
    }
  });
});

describe("failures of the machinery", () => {
  it("refuses sign-in (503) when the limit counters cannot be reached, instead of skipping them", async () => {
    vi.spyOn(prisma, "$queryRaw").mockRejectedValue(new Error("connection refused"));
    const errors = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const r = await login(loginReq("victim@test.local", PASSWORD));
    expect(r.status).toBe(503);
    expect(r.headers.get("retry-after")).toBe("5");
    expect(r.headers.get("set-cookie")).toBeNull();
    expect(await prisma.session.count()).toBe(0);
    expect(JSON.stringify(errors.mock.calls)).not.toContain(PASSWORD);
  });

  it("answers 503 when the password pool is full, without counting the attempt against anyone", async () => {
    process.env.AUTH_HASH_THREADS = "1";
    process.env.AUTH_HASH_MAX_QUEUE = "0";
    await resetHashPoolForTests();
    const rs = await Promise.all(Array.from({ length: 12 }, (_, i) => login(loginReq(i % 2 ? `victim${i}@test.local` : `nobody${i}@test.local`, WRONG))));
    const s = statuses(rs);
    expect(s[503]).toBeGreaterThan(0);
    expect((s[401] ?? 0) + s[503]!).toBe(12);
    // Only attempts that were really checked count.
    const counted = await prisma.authRateLimit.aggregate({ where: { key: { startsWith: "acct:" } }, _sum: { count: true } });
    expect(counted._sum.count).toBe(s[401]);
    expect(rs.find((r) => r.status === 503)!.headers.get("retry-after")).toBe("5");
    // And the account is still usable afterwards.
    expect((await login(loginReq("other@test.local", PASSWORD))).status).toBe(200);
  });
});

describe("bounded, secret-free records", () => {
  it("writes one audit entry for a flood of unknown emails, and keeps every checked attempt in login_attempts", async () => {
    process.env.AUTH_HASH_MAX_QUEUE = "100";
    process.env.AUTH_HASH_QUEUE_TIMEOUT_MS = "60000";
    const rs = await Promise.all(Array.from({ length: 50 }, (_, i) => login(loginReq(`made-up-${i}@test.local`, WRONG))));
    expect(statuses(rs)).toEqual({ 401: 50 });
    const unknown = await prisma.auditLog.findMany({ where: { action: "LOGIN_FAILED" } });
    expect(unknown).toHaveLength(1);
    expect(unknown[0]!.changes).toMatchObject({ cause: "unknown account", aggregated: true });
    expect(await prisma.loginAttempt.count({ where: { outcome: "UNKNOWN_ACCOUNT" } })).toBe(50);
  });

  it("stores no password, hash or plain email in counters, and none in the attempts or audit log", async () => {
    await login(loginReq("victim@test.local", WRONG));
    await login(loginReq("victim@test.local", PASSWORD));
    const counters = JSON.stringify(await prisma.authRateLimit.findMany());
    expect(counters).not.toContain("victim@test.local");
    const all = JSON.stringify([await prisma.loginAttempt.findMany(), await prisma.auditLog.findMany(), counters], (_, v) => (typeof v === "bigint" ? String(v) : v));
    for (const secret of [PASSWORD, WRONG, hash]) expect(all).not.toContain(secret);
    expect(all).not.toMatch(/\$2[aby]\$/);
    expect(await prisma.loginAttempt.findMany({ select: { outcome: true, success: true, userAgent: true }, orderBy: { id: "asc" } })).toEqual([
      { outcome: "BAD_PASSWORD", success: false, userAgent: "limits-test" },
      { outcome: "SUCCESS", success: true, userAgent: "limits-test" },
    ]);
  });

  it("deletes expired counters and attempts past retention, and nothing newer", async () => {
    const old = new Date(Date.now() - 40 * 86_400_000);
    await prisma.loginAttempt.createMany({ data: [{ email: "a@x", ipAddress: "unknown", success: false, createdAt: old }, { email: "b@x", ipAddress: "unknown", success: false }] });
    await prisma.authRateLimit.create({ data: { key: "acct:old", windowStart: old, count: 3, expiresAt: new Date(old.getTime() + 60_000) } });
    expect(await purgeOldLoginAttempts(new Date(Date.now() - 30 * 86_400_000), 1)).toBe(1);
    expect(await prisma.loginAttempt.count()).toBe(1);
    resetCleanupScheduleForTests();
    await login(loginReq("victim@test.local", WRONG)); // triggers the background housekeeping
    await vi.waitFor(async () => expect(await prisma.authRateLimit.count({ where: { key: "acct:old" } })).toBe(0));
    expect(await prisma.authRateLimit.count({ where: { key: accountKey("victim@test.local") } })).toBe(1);
  });
});
