import { createHash } from "node:crypto";

/**
 * Sign-in limits shared by the server (src/server/auth/rate-limit.ts) and the admin recovery
 * script (scripts/admin-password.ts). Pure: no database or server-only imports.
 *
 * Every limit counts attempts in a fixed time window. A request takes its slot before the password
 * is checked; a successful sign-in gives the slot back (and clears its account's count), so in
 * practice the counters hold failures plus attempts still in progress.
 */

function intFromEnv(name: string, fallback: number, min: number, max: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === "") return fallback;
  const n = Number(raw);
  return Number.isInteger(n) && n >= min && n <= max ? n : fallback;
}

export type LoginLimits = {
  /**
   * Attempts per account per client per window: per (account, trusted client address) behind a
   * trusted proxy, per account when the address is unknown, and per known device (see below).
   */
  perAccount: number;
  /**
   * Attempts per account per window across every client address together (only applies when the
   * address is known; without a trusted proxy every client is "unknown" and `perAccount` is the
   * account's limit). Stops guessing from many addresses.
   */
  perAccountTotal: number;
  /** Attempts per trusted client address per window (only with TRUSTED_PROXY_HOPS >= 1). */
  perAddress: number;
  /** Length of the per-account / per-address window. */
  windowMinutes: number;
  /** Attempts across all accounts and addresses per minute, for every app instance together. */
  globalPerMinute: number;
  /** Days that raw sign-in attempts (login_attempts) are kept for investigations. */
  attemptRetentionDays: number;
};

export function loginLimits(): LoginLimits {
  return {
    perAccount: intFromEnv("LOGIN_MAX_FAILURES_PER_ACCOUNT", 5, 1, 1000),
    perAccountTotal: intFromEnv("LOGIN_MAX_FAILURES_PER_ACCOUNT_TOTAL", 10, 1, 10_000),
    perAddress: intFromEnv("LOGIN_MAX_FAILURES_PER_IP", 30, 1, 100_000),
    windowMinutes: intFromEnv("LOGIN_FAILURE_WINDOW_MINUTES", 15, 1, 1440),
    globalPerMinute: intFromEnv("LOGIN_MAX_FAILURES_GLOBAL_PER_MINUTE", 300, 1, 1_000_000),
    attemptRetentionDays: intFromEnv("LOGIN_ATTEMPT_RETENTION_DAYS", 30, 1, 3650),
  };
}

/** Rate-limit key of an account. The email is hashed so the counters table holds no addresses. */
export function accountKey(email: string): string {
  return `acct:${createHash("sha256").update(email.trim().toLowerCase()).digest("hex")}`;
}

export function addressKey(ip: string): string {
  return `ip:${ip}`;
}

/** Rate-limit key of an account from one trusted client address. */
export function accountAddressKey(email: string, ip: string): string {
  return `acctip:${accountKey(email).slice("acct:".length)}:${ip}`;
}

/** Rate-limit key of a known device (the sha256 of its device token). */
export function deviceKey(tokenHash: string): string {
  return `dev:${tokenHash}`;
}

/** Rate-limit key of password-change attempts by a signed-in user. */
export function passwordChangeKey(userId: string): string {
  return `pwchange:${userId}`;
}

export const GLOBAL_KEY = "global";

/** Start of the fixed window of `minutes` that contains `now` (aligned to the Unix epoch). */
export function windowStart(now: Date, minutes: number): Date {
  const ms = minutes * 60_000;
  return new Date(Math.floor(now.getTime() / ms) * ms);
}
