import "server-only";
import { Prisma } from "@prisma/client";
import { accountAddressKey, accountKey, addressKey, deviceKey, GLOBAL_KEY, loginLimits, windowStart, type LoginLimits } from "@/lib/login-limits";
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
 * Sign-in from an UNKNOWN device (no valid device cookie for this account), in this order:
 *   1. global:  LOGIN_MAX_FAILURES_GLOBAL_PER_MINUTE across all accounts and addresses, and
 *      address: LOGIN_MAX_FAILURES_PER_IP per window for a trusted address (TRUSTED_PROXY_HOPS);
 *      "unknown" is never limited as one client, or one attacker could lock everybody out.
 *      Both in one statement. A request refused here writes nothing for any account.
 *   2. account: per (account, trusted address) LOGIN_MAX_FAILURES_PER_ACCOUNT, plus the account
 *      across all addresses LOGIN_MAX_FAILURES_PER_ACCOUNT_TOTAL. Without a trusted address the
 *      account alone has LOGIN_MAX_FAILURES_PER_ACCOUNT. Both in one statement.
 * Sign-in from a KNOWN device (src/server/auth/devices.ts): only the device's own counter,
 *   LOGIN_MAX_FAILURES_PER_ACCOUNT per window. Floods (global), other people's failures (account)
 *   and shared addresses never block it; guessing through it is limited like any other client,
 *   and a device token only exists after a correct password.
 *
 * A request refused by a limit keeps that limit's count (so exactly one request ever sees
 * limit + 1, which is audited once) and gives back every other slot it took. A successful sign-in
 * clears its account/device counters and gives back its address and global slots, so the counters
 * hold failures and attempts still in progress. An attempt that could not be checked (password
 * pool busy) gives back all of its slots.
 *
 * Once an instance sees the global limit reached, it refuses unknown-device sign-ins without any
 * database work until that one-minute window ends (the global count can only be lower than the
 * limit again by successes giving slots back, so this can only refuse a little early, never let
 * more through).
 *
 * When the counters cannot be reached the sign-in is refused (fail closed), never let through.
 */

export type LimitScope = "account" | "address" | "global" | "device";

type Slot = { key: string; windowStart: Date; expiresAt: Date };

/** `kept` slots are given back on success; `cleared` ones (the account/device failure counters) are deleted. */
export type LoginReservation = { kept: Slot[]; cleared: Slot[] };

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

async function remove(slots: Slot[], db: Db): Promise<void> {
  for (const s of slots) {
    await db.$executeRaw`DELETE FROM auth_rate_limits WHERE key = ${s.key} AND "windowStart" = ${s.windowStart}::timestamptz`;
  }
}

function secondsUntil(s: Slot, minutes: number, now: Date): number {
  return Math.max(1, Math.ceil((s.windowStart.getTime() + minutes * 60_000 - now.getTime()) / 1000));
}

// Per-instance memory of "the global limit is reached until <window end>" (see above).
const TRIP_KEY = Symbol.for("ims.authGlobalTripped");
type TripState = { until: number };
const gTrip = globalThis as typeof globalThis & { [TRIP_KEY]?: TripState };

export type ReserveOptions = { now?: Date; limits?: LoginLimits; /** Tests: another connection pool, standing in for another app instance. */ db?: Db };

/** Sign-in from an unknown device: global and address first, then the account. */
export async function reserveLoginAttempt(email: string, ip: string, opts: ReserveOptions = {}): Promise<ReserveResult> {
  const now = opts.now ?? new Date();
  const limits = opts.limits ?? loginLimits();
  const db = opts.db ?? prisma;
  const trip = (gTrip[TRIP_KEY] ??= { until: 0 });
  if (trip.until > now.getTime()) {
    return { ok: false, scope: "global", firstBlock: false, retryAfterSeconds: Math.max(1, Math.ceil((trip.until - now.getTime()) / 1000)) };
  }
  void scheduleCleanup(now, limits);

  const known = ip !== UNKNOWN_ADDRESS;
  const address = known ? slot(addressKey(ip), now, limits.windowMinutes) : null;
  const global = slot(GLOBAL_KEY, now, 1);
  // Always in the same order (address, then global; per-address account, then account) so
  // concurrent statements cannot deadlock.
  const shared = address ? [address, global] : [global];
  const counts = await increment(shared, db);
  const addressCount = address ? counts.get(address.key)! : 0;
  const globalCount = counts.get(global.key)!;
  if (address && addressCount > limits.perAddress) {
    await decrement([global], db);
    return { ok: false, scope: "address", firstBlock: addressCount === limits.perAddress + 1, retryAfterSeconds: secondsUntil(address, limits.windowMinutes, now) };
  }
  if (globalCount > limits.globalPerMinute) {
    if (address) await decrement([address], db);
    trip.until = global.windowStart.getTime() + 60_000;
    return { ok: false, scope: "global", firstBlock: globalCount === limits.globalPerMinute + 1, retryAfterSeconds: secondsUntil(global, 1, now) };
  }

  const accountSlots: { s: Slot; limit: number }[] = known
    ? [
        { s: slot(accountAddressKey(email, ip), now, limits.windowMinutes), limit: limits.perAccount },
        { s: slot(accountKey(email), now, limits.windowMinutes), limit: limits.perAccountTotal },
      ]
    : [{ s: slot(accountKey(email), now, limits.windowMinutes), limit: limits.perAccount }];
  let accCounts: Map<string, number>;
  try {
    accCounts = await increment(accountSlots.map((a) => a.s), db);
  } catch (e) {
    await decrement(shared, db).catch(() => undefined);
    throw e;
  }
  const over = accountSlots.find((a) => accCounts.get(a.s.key)! > a.limit);
  if (over) {
    // The limit that refused keeps its count; everything else is given back.
    await decrement([...shared, ...accountSlots.filter((a) => a !== over).map((a) => a.s)], db);
    return { ok: false, scope: "account", firstBlock: accCounts.get(over.s.key)! === over.limit + 1, retryAfterSeconds: secondsUntil(over.s, limits.windowMinutes, now) };
  }
  return { ok: true, reservation: { kept: shared, cleared: accountSlots.map((a) => a.s) } };
}

/** Sign-in from a known device: only the device's own failure counter. */
export async function reserveDeviceAttempt(tokenHash: string, opts: ReserveOptions = {}): Promise<ReserveResult> {
  const now = opts.now ?? new Date();
  const limits = opts.limits ?? loginLimits();
  const db = opts.db ?? prisma;
  void scheduleCleanup(now, limits);
  const device = slot(deviceKey(tokenHash), now, limits.windowMinutes);
  const count = (await increment([device], db)).get(device.key)!;
  if (count > limits.perAccount) {
    return { ok: false, scope: "device", firstBlock: count === limits.perAccount + 1, retryAfterSeconds: secondsUntil(device, limits.windowMinutes, now) };
  }
  return { ok: true, reservation: { kept: [], cleared: [device] } };
}

/** The password was right: its failure counters are forgotten and the shared slots given back. */
export async function settleLoginSuccess(r: LoginReservation, db: Db = prisma): Promise<void> {
  await remove(r.cleared, db);
  await decrement(r.kept, db);
}

/** The attempt was not checked (temporary server problem): it does not count against anyone. */
export async function releaseLoginAttempt(r: LoginReservation, db: Db = prisma): Promise<void> {
  await decrement([...r.cleared, ...r.kept], db);
}

export type SlotResult = { ok: true; slot: Slot } | { ok: false; firstBlock: boolean; retryAfterSeconds: number };

/**
 * One limited counter (e.g. password changes of a signed-in user): `limit` attempts per window of
 * `minutes`, taken atomically like the sign-in limits. On success call `clearSlot`; when the attempt
 * could not be made, `releaseSlot`.
 */
export async function takeSlot(key: string, limit: number, minutes: number, opts: { now?: Date; db?: Db } = {}): Promise<SlotResult> {
  const now = opts.now ?? new Date();
  const s = slot(key, now, minutes);
  const count = (await increment([s], opts.db ?? prisma)).get(s.key)!;
  if (count > limit) return { ok: false, firstBlock: count === limit + 1, retryAfterSeconds: secondsUntil(s, minutes, now) };
  return { ok: true, slot: s };
}

/** The current count of a limited counter (0 when absent). Only used to refuse early; admission is `takeSlot`. */
export async function slotCount(key: string, minutes: number, opts: { now?: Date; db?: Db } = {}): Promise<number> {
  const s = slot(key, opts.now ?? new Date(), minutes);
  const rows = await (opts.db ?? prisma).$queryRaw<{ count: number }[]>`
    SELECT count FROM auth_rate_limits WHERE key = ${s.key} AND "windowStart" = ${s.windowStart}::timestamptz`;
  return Number(rows[0]?.count ?? 0);
}

export async function clearSlot(s: Slot, db: Db = prisma): Promise<void> {
  await remove([s], db);
}

export async function releaseSlot(s: Slot, db: Db = prisma): Promise<void> {
  await decrement([s], db);
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
      // Expired known-device tokens (src/server/auth/devices.ts); at most 10 per user exist.
      await prisma.loginDevice.deleteMany({ where: { expiresAt: { lt: now } } });
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

/** Tests: run housekeeping on the next request again, and forget a tripped global limit. */
export function resetCleanupScheduleForTests() {
  g[CLEANUP_KEY] = undefined;
  gTrip[TRIP_KEY] = undefined;
}
