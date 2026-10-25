import "server-only";
import { prisma } from "../db";

const WINDOW_MS = 15 * 60 * 1000;
const MAX_FAILURES_PER_EMAIL = 5;
const MAX_FAILURES_PER_IP = 30;

/** Database-backed so the limit holds across multiple app instances. */
export async function isLoginBlocked(email: string, ipAddress: string): Promise<boolean> {
  const since = new Date(Date.now() - WINDOW_MS);
  const [byEmail, byIp] = await Promise.all([
    prisma.loginAttempt.count({ where: { email, success: false, createdAt: { gte: since } } }),
    prisma.loginAttempt.count({ where: { ipAddress, success: false, createdAt: { gte: since } } }),
  ]);
  return byEmail >= MAX_FAILURES_PER_EMAIL || byIp >= MAX_FAILURES_PER_IP;
}

export async function recordLoginAttempt(email: string, ipAddress: string, success: boolean) {
  await prisma.loginAttempt.create({ data: { email: email.slice(0, 254), ipAddress: ipAddress.slice(0, 100), success } });
  if (success) {
    // A successful login clears the failure streak for this account.
    await prisma.loginAttempt.deleteMany({ where: { email, success: false } });
  }
  // Opportunistic cleanup of old rows.
  if (Math.random() < 0.05) {
    await prisma.loginAttempt.deleteMany({ where: { createdAt: { lt: new Date(Date.now() - 24 * 60 * 60 * 1000) } } });
  }
}

export function clientIp(req: Request): string {
  const forwarded = req.headers.get("x-forwarded-for");
  if (forwarded) return forwarded.split(",")[0]!.trim() || "unknown";
  return req.headers.get("x-real-ip") ?? "unknown";
}
