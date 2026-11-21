import "server-only";
import { Prisma } from "@prisma/client";
import { accountKey, addressKey, GLOBAL_KEY, loginLimits, windowStart, type LoginLimits } from "@/lib/login-limits";
import { prisma, type Db } from "../db";
import { UNKNOWN_ADDRESS } from "./client-ip";

export { clientIp } from "./client-ip";

/**
 * Sign-in limits, shared by every app instance through PostgreSQL (table auth_rate_limits).
 *
 * Each limit is a counter per (key, fixed window). A request takes a slot with one atomic
 * `INSERT ... ON CONFLICT DO UPDATE SET count = count + 1 RETURNING count`: PostgreSQL serialises
 * the increments on the row, so every concurrent request sees a distinct count and exactly
 * `limit` of them get a count <= limit, however many arrive at once or on however many instances.
 * There is no read-then-write. Whether a row was inserted or updated is never needed.
 *
 *   1. account (email, hashed): LOGIN_MAX_FAILURES_PER_ACCOUNT per LOGIN_FAILURE_WINDOW_MINUTES
 *   2. client address:          LOGIN_MAX_FAILURES_PER_IP per window, only for a trusted address
 *                               (TRUSTED_PROXY_HOPS); "unknown" is never limited as one client,
 *                               or one attacker could lock everybody out
 *   3. global:                  LOGIN_MAX_FAILURES_GLOBAL_PER_MINUTE across all accounts/addresses
 *
 * The account slot is taken first; a request refused there touches nothing else. A request refused
 * by 2 or 3 gives its account slot back. A successful sign-in clears its account's counter and gives
 * back its address and global slots, so the counters hold failures and attempts still in progress.
 * An attempt that could not be checked (password pool busy) gives back all of its slots.
 *
 * When the counters cannot be reached the sign-in is refused (fail closed), never let through.
 */

export type LimitScope = "account" | "address" | "global";

type Slot = { key: string; windowStart: Date; expiresAt: Date };

export type LoginReservation = { account: Slot; others: Slot[] };

export type ReserveResult =
  | { ok: true; reservation: LoginReservation }
  /** firstBlock: this request is the first one refused for that key in this window (audit it once). */
  | { ok: false; scope: LimitScope; firstBlock: boolean; retryAfterSeconds: number };

function slot(key: string, now: Date, minutes: number): Slot {
  const start = windowStart(now, minutes);
  // Kept one extra window so a refund that races the window end still finds its row.
  return { key, windowStart: start, expiresAt: new Date(start.getTime() + 2 * minutes * 60_000) };
}

/** Atomically adds one to each counter (created at 1 when missing) and returns the new counts. */
async function increment(slots: Slot[], db: Db): Promise<Map<string, number>> {
  const rows = await db.$queryRaw<{ key: string; count: number }[]>`
    INSERT INTO auth_rate_limits (key, "windowStart", count, "expiresAt")
    VALUES ${Prisma.join(slots.map((s) => Prisma.sql`(${s.key}, ${s.windowStart}::timestamptz, 1, ${s.expiresAt}::timestamptz)`))}
    ON CONFLICT (key, "windowStart") DO UPDATE SET count = auth_rate_limits.count + 1
    RETURNING key, count`;
  return new Map(rows.map((r) => [r.key, Number(r.count)]));
}

async function decrement(slots: Slot[], db: Db): Promise<void> {
  for (const s of slots) {
    await db.$executeRaw`
      UPDATE auth_rate_limits SET count = GREATEST(count - 1, 0)
      WHERE key = ${s.key} AND "windowStart" = ${s.windowStart}::timestamptz`;
  }
}

function secondsUntil(s: Slot, minutes: number, now: Date): number {
  return Math.max(1, Math.ceil((s.windowStart.getTime() + minutes * 60_000 - now.getTime()) / 1000));
}

export type ReserveOptions = { now?: Date; limits?: LoginLimits; /** Tests: another connection pool, standing in for another app instance. */ db?: Db };

export async function reserveLoginAttempt(email: string, ip: string, opts: ReserveOptions = {}): Promise<ReserveResult> {
  const now = opts.now ?? new Date();
  const limits = opts.limits ?? loginLimits();
  const db = opts.db ?? prisma;
  void scheduleCleanup(now, limits);
  const account = slot(accountKey(email), now, limits.windowMinutes);
  const accountCount = (await increment([account], db)).get(account.key)!;
  if (accountCount > limits.perAccount) {
    // Not given back: the account stays locked for the rest of the window, and the count keeps
    // rising, so exactly one request ever sees limit + 1.
    return { ok: false, scope: "account", firstBlock: accountCount === limits.perAccount + 1, retryAfterSeconds: secondsUntil(account, limits.windowMinutes, now) };
  }

  const address = ip !== UNKNOWN_ADDRESS ? slot(addressKey(ip), now, limits.windowMinutes) : null;
  const global = slot(GLOBAL_KEY, now, 1);
  // Always in the same order (address, then global) so concurrent statements cannot deadlock.
  const others = address ? [address, global] : [global];
  let counts: Map<string, number>;
  try {
    counts = await increment(others, db);
  } catch (e) {
    await decrement([account], db).catch(() => undefined);
    throw e;
  }
  const addressCount = address ? counts.get(address.key)! : 0;
  const globalCount = counts.get(global.key)!;
  if (address && addressCount > limits.perAddress) {
    await decrement([account, global], db);
    return { ok: false, scope: "address", firstBlock: addressCount === limits.perAddress + 1, retryAfterSeconds: secondsUntil(address, limits.windowMinutes, now) };
  }
  if (globalCount > limits.globalPerMinute) {
    await decrement(address ? [account, address] : [account], db);
    return { ok: false, scope: "global", firstBlock: globalCount === limits.globalPerMinute + 1, retryAfterSeconds: secondsUntil(global, 1, now) };
  }
  return { ok: true, reservation: { account, others } };
}

/** The password was right: the account's failures are forgotten and the other slots given back. */
export async function settleLoginSuccess(r: LoginReservation, db: Db = prisma): Promise<void> {
  await db.$executeRaw`DELETE FROM auth_rate_limits WHERE key = ${r.account.key} AND "windowStart" = ${r.account.windowStart}::timestamptz`;
  await decrement(r.others, db);
}

/** The attempt was not checked (temporary server problem): it does not count against anyone. */
export async function releaseLoginAttempt(r: LoginReservation, db: Db = prisma): Promise<void> {
  await decrement([r.account, ...r.others], db);
}

/**
 * Takes a one-time marker for (key, window): true for exactly one caller per window across all
 * instances (`INSERT ... ON CONFLICT DO NOTHING RETURNING`: a row comes back only to the inserter).
 * Used to write one audit entry per window instead of one per request.
 */
export async function claimOnce(key: string, minutes: number, now = new Date(), db: Db = prisma): Promise<boolean> {
  const s = slot(key, now, minutes);
  const rows = await db.$queryRaw<{ key: string }[]>`
    INSERT INTO auth_rate_limits (key, "windowStart", count, "expiresAt")
    VALUES (${s.key}, ${s.windowStart}::timestamptz, 1, ${s.expiresAt}::timestamptz)
    ON CONFLICT (key, "windowStart") DO NOTHING
    RETURNING key`;
  return rows.length === 1;
}

export type AttemptOutcome = "SUCCESS" | "BAD_PASSWORD" | "UNKNOWN_ACCOUNT" | "INACTIVE";

/**
 * Raw record of a sign-in whose password was checked (for investigations; see docs). Requests
 * refused by a limit are not recorded here: they only raise the counters, so a flood cannot grow
 * this table faster than the limits and the password pool allow.
 */
export async function recordLoginAttempt(email: string, ipAddress: string, outcome: AttemptOutcome, userAgent: string | null): Promise<void> {
  await prisma.loginAttempt.create({
    data: {
      email: email.slice(0, 254),
      ipAddress: ipAddress.slice(0, 100),
      success: outcome === "SUCCESS",
      outcome,
      userAgent: userAgent ? userAgent.slice(0, 300) : null,
    },
  });
}

// Housekeeping, at most once a minute (expired counters) / once an hour (old attempts) per
// instance, in the background. Deletes are idempotent, so instances running them together is safe.
const CLEANUP_KEY = Symbol.for("ims.authRateLimitCleanup");
type CleanupState = { countersAt: number; attemptsAt: number; running: boolean };
const g = globalThis as typeof globalThis & { [CLEANUP_KEY]?: CleanupState };

async function scheduleCleanup(now: Date, limits: LoginLimits): Promise<void> {
  const state = (g[CLEANUP_KEY] ??= { countersAt: 0, attemptsAt: 0, running: false });
  const t = now.getTime();
  const counters = t - state.countersAt >= 60_000;
  const attempts = t - state.attemptsAt >= 3_600_000;
  if (state.running || (!counters && !attempts)) return;
  state.running = true;
  try {
    if (counters) {
      state.countersAt = t;
      await prisma.$executeRaw`DELETE FROM auth_rate_limits WHERE "expiresAt" < ${now}::timestamptz`;
    }
    if (attempts) {
      state.attemptsAt = t;
      await purgeOldLoginAttempts(new Date(t - limits.attemptRetentionDays * 86_400_000));
    }
  } catch (e) {
    console.error("[auth] rate-limit cleanup failed:", e instanceof Error ? e.message : "error");
  } finally {
    state.running = false;
  }
}

/** Deletes attempts older than `before`, in batches so no single statement holds locks for long. */
export async function purgeOldLoginAttempts(before: Date, batch = 5000): Promise<number> {
  let total = 0;
  for (let i = 0; i < 1000; i++) {
    const n = await prisma.$executeRaw`
      DELETE FROM login_attempts WHERE id IN (
        SELECT id FROM login_attempts WHERE "createdAt" < ${before}::timestamptz ORDER BY "createdAt" LIMIT ${batch})`;
    total += n;
    if (n < batch) break;
  }
  return total;
}

/** Tests: run housekeeping on the next request again. */
export function resetCleanupScheduleForTests() {
  g[CLEANUP_KEY] = undefined;
}
