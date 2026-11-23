import "server-only";
import { prisma } from "../db";
import { isRandomToken, randomToken, sha256 } from "./crypto";
import { cookieFromHeader, isSecureRequest } from "./session";

/**
 * Known sign-in devices (table login_devices). After a successful sign-in the browser gets a random
 * token in an httpOnly cookie that is only sent to /api/auth. A later sign-in to the SAME account
 * with a valid token is "known": it is limited by its own failure counter instead of the
 * account/address/global counters, and its password check uses the pool's priority lane. So someone
 * who floods the sign-in or keeps an account locked cannot lock out the person who uses it.
 *
 * The token is not a credential (the password is still checked every time) and reveals nothing:
 * tokens are random, only their SHA-256 is stored, and a token for another account, an expired one
 * or an unknown one is simply ignored. Shared by every app instance through the database.
 */

export const DEVICE_COOKIE = "ims_device";
const DEVICE_PATH = "/api/auth";
const DEVICE_TTL_DAYS = 90;
const MAX_DEVICES_PER_USER = 10;

/** `token` is the raw cookie value, kept in memory only to refresh the cookie. */
export type KnownDevice = { tokenHash: string; userId: string; token: string };

/** The known device of this request for the account `email`, or null (absent, unknown, expired, other account). */
export async function knownDeviceFor(req: Request, email: string, now = new Date()): Promise<KnownDevice | null> {
  const token = cookieFromHeader(req.headers.get("cookie"), DEVICE_COOKIE);
  // Only a value shaped like a token we issue (randomToken) is looked up: forged values of any other
  // shape, and malformed ones (null above), cost no database read.
  if (!token || !isRandomToken(token)) return null;
  const tokenHash = sha256(token);
  const row = await prisma.loginDevice.findUnique({ where: { tokenHash }, select: { userId: true, expiresAt: true, user: { select: { email: true, isActive: true } } } });
  if (!row || row.expiresAt <= now || !row.user.isActive || row.user.email !== email) return null;
  return { tokenHash, userId: row.userId, token };
}

/**
 * After a successful sign-in: keeps the browser's device token (refreshing it) or gives it a new
 * one, and keeps at most MAX_DEVICES_PER_USER per user (the least recently used go first).
 * Returns the cookie to set (always, so its lifetime is refreshed too).
 */
export async function rememberDevice(req: Request, userId: string, current: KnownDevice | null, now = new Date()) {
  const expiresAt = new Date(now.getTime() + DEVICE_TTL_DAYS * 86_400_000);
  let token: string;
  if (current && current.userId === userId) {
    token = current.token;
    await prisma.loginDevice.update({ where: { tokenHash: current.tokenHash }, data: { lastUsedAt: now, expiresAt } });
  } else {
    token = randomToken();
    await prisma.loginDevice.create({ data: { tokenHash: sha256(token), userId, createdAt: now, lastUsedAt: now, expiresAt } });
    const extra = await prisma.loginDevice.findMany({ where: { userId }, orderBy: { lastUsedAt: "desc" }, skip: MAX_DEVICES_PER_USER, select: { tokenHash: true } });
    if (extra.length) await prisma.loginDevice.deleteMany({ where: { tokenHash: { in: extra.map((d) => d.tokenHash) } } });
  }
  // Sent every time, so the browser's copy expires together with the stored one.
  return {
    name: DEVICE_COOKIE,
    value: token,
    httpOnly: true,
    sameSite: "lax" as const,
    secure: isSecureRequest(req),
    path: DEVICE_PATH,
    maxAge: DEVICE_TTL_DAYS * 86_400,
  };
}

/** Housekeeping: expired device tokens. */
export async function purgeExpiredDevices(now = new Date()): Promise<number> {
  return (await prisma.loginDevice.deleteMany({ where: { expiresAt: { lt: now } } })).count;
}
