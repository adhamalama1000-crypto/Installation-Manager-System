/**
 * Sign-in stays available under hostile traffic (audit H1/M4): known devices keep a lane that floods
 * and targeted lockouts cannot take, one client cannot monopolise the password pool, a tripped
 * global limit costs no database writes, spoofed forwarding headers change nothing, and the
 * counters still fail closed.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { POST as login } from "@/app/api/auth/login/route";
import { hashPassword } from "@/server/auth/password";
import { getHashPool, resetHashPoolForTests } from "@/server/auth/hash-pool";
import { resetCleanupScheduleForTests } from "@/server/auth/rate-limit";
import { DEVICE_COOKIE } from "@/server/auth/devices";
import { sha256 } from "@/server/auth/crypto";
import { accountKey, deviceKey } from "@/lib/login-limits";
import { makeUser, prisma, resetDb } from "../helpers";

const PASSWORD = "Password123";
const WRONG = "Wrong-Password-9";

function loginReq(email: string, password: string, headers: Record<string, string> = {}) {
  return new Request("http://localhost:3000/api/auth/login", {
    method: "POST",
    headers: { host: "localhost:3000", "content-type": "application/json", "user-agent": "availability-test", ...headers },
    body: JSON.stringify({ email, password }),
  });
}
const statuses = (rs: Response[]) => rs.reduce<Record<number, number>>((m, r) => ((m[r.status] = (m[r.status] ?? 0) + 1), m), {});
const deviceCookieOf = (res: Response) => res.headers.getSetCookie().find((c) => c.startsWith(`${DEVICE_COOKIE}=`))?.split(";")[0];

const ENV = [
  "TRUSTED_PROXY_HOPS", "LOGIN_MAX_FAILURES_PER_ACCOUNT", "LOGIN_MAX_FAILURES_PER_ACCOUNT_TOTAL", "LOGIN_MAX_FAILURES_GLOBAL_PER_MINUTE",
  "AUTH_HASH_THREADS", "AUTH_HASH_MAX_QUEUE", "AUTH_HASH_QUEUE_TIMEOUT_MS", "AUTH_HASH_PRIORITY_RESERVE", "AUTH_HASH_MAX_PER_CLIENT",
];
let hash: string;

async function awayFromWindowEdge() {
  const left = (minutes: number) => minutes * 60_000 - (Date.now() % (minutes * 60_000));
  const wait = Math.min(left(1), left(15));
  if (wait < 15_000) await new Promise((r) => setTimeout(r, wait + 200));
}

/** Signs the victim in once and returns their device cookie ("ims_device=..."). */
async function knownDevice(email = "victim@test.local", headers: Record<string, string> = {}) {
  const res = await login(loginReq(email, PASSWORD, headers));
  expect(res.status).toBe(200);
  const cookie = deviceCookieOf(res);
  expect(cookie).toBeTruthy();
  return cookie!;
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
  resetCleanupScheduleForTests();
});

describe("known devices", () => {
  it("are remembered after a successful sign-in, only as a hash, with a cookie limited to /api/auth", async () => {
    const res = await login(loginReq("victim@test.local", PASSWORD));
    const header = res.headers.getSetCookie().find((c) => c.startsWith(`${DEVICE_COOKIE}=`))!;
    expect(header).toMatch(/HttpOnly/i);
    expect(header).toMatch(/Path=\/api\/auth/i);
    const token = header.split(";")[0]!.split("=")[1]!;
    const rows = await prisma.loginDevice.findMany();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.tokenHash).toBe(sha256(token));
    expect(JSON.stringify(rows)).not.toContain(token);
    // Signing in again from the same browser keeps the same device (no new row).
    const again = await login(loginReq("victim@test.local", PASSWORD, { cookie: header.split(";")[0]! }));
    expect(deviceCookieOf(again)).toBe(header.split(";")[0]);
    expect(await prisma.loginDevice.count()).toBe(1);
    // A failed sign-in never issues one.
    expect(deviceCookieOf(await login(loginReq("other@test.local", WRONG)))).toBeUndefined();
  });

  it("keep the real user signing in while an attacker keeps the account locked (no trusted proxy)", async () => {
    const device = await knownDevice();
    // The attacker knows the email and keeps failing: the account is locked for unknown devices.
    const attack = await Promise.all(Array.from({ length: 20 }, () => login(loginReq("victim@test.local", WRONG))));
    expect(statuses(attack)).toEqual({ 401: 5, 429: 15 });
    expect((await login(loginReq("victim@test.local", PASSWORD))).status).toBe(429);
    // The real user, from their known browser, still gets in.
    expect((await login(loginReq("victim@test.local", PASSWORD, { cookie: device }))).status).toBe(200);
    // And the attacker's lock stayed in place (a known-device success does not reset it).
    expect((await login(loginReq("victim@test.local", PASSWORD))).status).toBe(429);
  });

  it("are limited themselves: 5 wrong passwords per window per device, exactly, under concurrency", async () => {
    const device = await knownDevice();
    const tokenHash = sha256(device.split("=")[1]!);
    process.env.AUTH_HASH_MAX_PER_CLIENT = "0"; // this test is about the counter, not the per-client pool cap
    process.env.AUTH_HASH_MAX_QUEUE = "100";
    process.env.AUTH_HASH_QUEUE_TIMEOUT_MS = "60000";
    await resetHashPoolForTests();
    const rs = await Promise.all(Array.from({ length: 30 }, () => login(loginReq("victim@test.local", WRONG, { cookie: device }))));
    expect(statuses(rs)).toEqual({ 401: 5, 429: 25 });
    expect((await prisma.authRateLimit.findFirstOrThrow({ where: { key: deviceKey(tokenHash) } })).count).toBe(30);
    // The device lane does not touch the account's counter.
    expect(await prisma.authRateLimit.count({ where: { key: accountKey("victim@test.local") } })).toBe(0);
  });

  it("only count for the account they belong to; others' and unknown tokens are ignored", async () => {
    const otherDevice = await knownDevice("other@test.local");
    await Promise.all(Array.from({ length: 6 }, () => login(loginReq("victim@test.local", WRONG))));
    // other@'s device cookie does not unlock victim@.
    expect((await login(loginReq("victim@test.local", PASSWORD, { cookie: otherDevice }))).status).toBe(429);
    expect((await login(loginReq("victim@test.local", PASSWORD, { cookie: `${DEVICE_COOKIE}=made-up-token` }))).status).toBe(429);
    // An expired device is unknown again.
    const device = await knownDevice("other@test.local", { cookie: otherDevice });
    await prisma.loginDevice.updateMany({ data: { expiresAt: new Date(Date.now() - 1000) } });
    await Promise.all(Array.from({ length: 6 }, () => login(loginReq("other@test.local", WRONG))));
    expect((await login(loginReq("other@test.local", PASSWORD, { cookie: device }))).status).toBe(429);
  });
});

describe("floods", () => {
  it("cannot starve a known device of the password pool (one client, no trusted proxy)", async () => {
    const device = await knownDevice();
    // A small pool: 1 worker + 5 queued, 2 places kept for known devices.
    process.env.AUTH_HASH_THREADS = "1";
    process.env.AUTH_HASH_MAX_QUEUE = "5";
    process.env.AUTH_HASH_PRIORITY_RESERVE = "2";
    process.env.AUTH_HASH_QUEUE_TIMEOUT_MS = "60000";
    await resetHashPoolForTests();
    const flood = Array.from({ length: 40 }, (_, i) => login(loginReq(`made-up-${i}@test.local`, WRONG)));
    await new Promise((r) => setTimeout(r, 20)); // the flood has taken its places
    const real = await login(loginReq("victim@test.local", PASSWORD, { cookie: device }));
    expect(real.status).toBe(200);
    const s = statuses(await Promise.all(flood));
    // The flood got at most the standard share (4 places at once); the rest were refused at once.
    expect(s[503]).toBeGreaterThan(0);
    expect(getHashPool().stats().rejectedLane).toBeGreaterThan(0);
  });

  it("from one trusted address cannot take more than 2 places, so another client still signs in", async () => {
    process.env.TRUSTED_PROXY_HOPS = "1";
    process.env.AUTH_HASH_MAX_QUEUE = "100";
    process.env.AUTH_HASH_QUEUE_TIMEOUT_MS = "60000";
    await resetHashPoolForTests();
    const flood = Array.from({ length: 30 }, (_, i) => login(loginReq(`made-up-${i}@test.local`, WRONG, { "x-forwarded-for": "203.0.113.66" })));
    await new Promise((r) => setTimeout(r, 20));
    expect(getHashPool().stats().inFlightStandard).toBeLessThanOrEqual(2);
    // A different person (another address, no known device) gets in without waiting for the flood.
    const t = Date.now();
    expect((await login(loginReq("victim@test.local", PASSWORD, { "x-forwarded-for": "198.51.100.20" }))).status).toBe(200);
    expect(Date.now() - t).toBeLessThan(3000);
    const s = statuses(await Promise.all(flood));
    // Most of the flood was refused by the per-client cap (a few may start after earlier ones finished).
    expect(s[503]).toBeGreaterThanOrEqual(20);
    expect(getHashPool().stats().rejectedClient).toBeGreaterThanOrEqual(20);
  });

  it("past the global limit write nothing more, and never touch account counters", async () => {
    process.env.LOGIN_MAX_FAILURES_GLOBAL_PER_MINUTE = "5";
    const device = await knownDevice(); // success: gives its global slot back
    for (let i = 0; i < 5; i++) expect((await login(loginReq(`spray-${i}@test.local`, WRONG))).status).toBe(401);
    // The 6th trips the global limit: one write (the global counter), no account counter.
    expect((await login(loginReq("spray-5@test.local", WRONG))).status).toBe(429);
    expect(await prisma.authRateLimit.count({ where: { key: accountKey("spray-5@test.local") } })).toBe(0);
    // Every later unknown-device sign-in in this minute is refused without any database work.
    const raw = vi.spyOn(prisma, "$queryRaw");
    const exec = vi.spyOn(prisma, "$executeRaw");
    const create = vi.spyOn(prisma.loginAttempt, "create");
    const rs = await Promise.all(Array.from({ length: 50 }, (_, i) => login(loginReq(`spray-${10 + i}@test.local`, WRONG))));
    expect(statuses(rs)).toEqual({ 429: 50 });
    expect(rs[0]!.headers.get("retry-after")).toBeTruthy();
    expect(raw).not.toHaveBeenCalled();
    expect(exec).not.toHaveBeenCalled();
    expect(create).not.toHaveBeenCalled();
    vi.restoreAllMocks();
    expect(await prisma.authRateLimit.count({ where: { key: { startsWith: "acct:" } } })).toBe(5);
    // A known device is not subject to the global limit.
    expect((await login(loginReq("victim@test.local", PASSWORD, { cookie: device }))).status).toBe(200);
    // The global block was audited once.
    expect(await prisma.auditLog.count({ where: { action: "LOGIN_BLOCKED", entityId: "global" } })).toBe(1);
  });
});

describe("targeted lockout behind a trusted proxy", () => {
  it("from one address locks only that address's attempts at the account", async () => {
    process.env.TRUSTED_PROXY_HOPS = "1";
    for (let i = 0; i < 5; i++) expect((await login(loginReq("victim@test.local", WRONG, { "x-forwarded-for": "203.0.113.66" }))).status).toBe(401);
    expect((await login(loginReq("victim@test.local", PASSWORD, { "x-forwarded-for": "203.0.113.66" }))).status).toBe(429);
    // The real user from their own address (no known device needed) still gets in.
    expect((await login(loginReq("victim@test.local", PASSWORD, { "x-forwarded-for": "198.51.100.20" }))).status).toBe(200);
  });

  it("cannot be dodged by spoofing X-Forwarded-For: only the proxy-appended address counts", async () => {
    process.env.TRUSTED_PROXY_HOPS = "1";
    for (let i = 0; i < 5; i++) {
      expect((await login(loginReq("victim@test.local", WRONG, { "x-forwarded-for": `10.9.${i}.1, 203.0.113.66` }))).status).toBe(401);
    }
    expect((await login(loginReq("victim@test.local", WRONG, { "x-forwarded-for": "10.9.99.1, 203.0.113.66", "x-real-ip": "10.1.1.1" }))).status).toBe(429);
  });

  it("from many addresses stops at 10 for the account; known devices still get in", async () => {
    process.env.TRUSTED_PROXY_HOPS = "1";
    const device = await knownDevice("victim@test.local", { "x-forwarded-for": "198.51.100.20" });
    for (const ip of ["203.0.113.1", "203.0.113.2"]) {
      for (let i = 0; i < 5; i++) expect((await login(loginReq("victim@test.local", WRONG, { "x-forwarded-for": ip }))).status).toBe(401);
    }
    // 10 failures across addresses: the account is locked for unknown devices from anywhere.
    expect((await login(loginReq("victim@test.local", PASSWORD, { "x-forwarded-for": "198.51.100.77" }))).status).toBe(429);
    expect((await login(loginReq("victim@test.local", PASSWORD, { "x-forwarded-for": "198.51.100.77", cookie: device }))).status).toBe(200);
  });
});

describe("failures of the machinery", () => {
  it("still fail closed for unknown and known devices when the counters cannot be reached", async () => {
    const device = await knownDevice();
    const errors = vi.spyOn(console, "error").mockImplementation(() => undefined);
    vi.spyOn(prisma, "$queryRaw").mockRejectedValue(new Error("connection refused"));
    for (const headers of [{}, { cookie: device }] as Record<string, string>[]) {
      const r = await login(loginReq("victim@test.local", PASSWORD, headers));
      expect(r.status).toBe(503);
      expect(r.headers.get("set-cookie")).toBeNull();
    }
    vi.spyOn(prisma.loginDevice, "findUnique").mockRejectedValue(new Error("connection refused"));
    expect((await login(loginReq("victim@test.local", PASSWORD, { cookie: device }))).status).toBe(503);
    expect(JSON.stringify(errors.mock.calls)).not.toContain(PASSWORD);
    expect(await prisma.session.count()).toBe(1); // only the session from knownDevice()
  });
});
