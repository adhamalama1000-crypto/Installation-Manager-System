/**
 * Recovering access to the demo Admin account (admin@example.com) without touching anything else.
 * Used by scripts/reset-admin-password.ts and its tests. Never prints or returns a password or a
 * hash.
 */
import type { PrismaClient } from "@prisma/client";
import bcrypt from "bcryptjs";

/** The only account these functions read or change. */
export const ADMIN_EMAIL = "admin@example.com";

/** The same limits as the sign-in (src/server/auth/rate-limit.ts). */
const WINDOW_MS = 15 * 60 * 1000;
const MAX_FAILURES_PER_EMAIL = 5;
const MAX_FAILURES_PER_IP = 30;

export type AdminStatus = {
  exists: boolean;
  role: string | null;
  isActive: boolean | null;
  hasPassword: boolean;
  /** Failed sign-ins for this email in the last 15 minutes. */
  recentFailures: number;
  /** This email is locked out right now (5 failures in 15 minutes). */
  emailLocked: boolean;
  /** Addresses locked out right now (30 failures in 15 minutes, any accounts). */
  lockedAddresses: string[];
  sessions: number;
};

/** Read-only: the state of admin@example.com and of the sign-in lockout. */
export async function adminStatus(prisma: PrismaClient, now = new Date()): Promise<AdminStatus> {
  const since = new Date(now.getTime() - WINDOW_MS);
  const user = await prisma.user.findUnique({ where: { email: ADMIN_EMAIL }, select: { id: true, role: true, isActive: true, passwordHash: true } });
  const [recentFailures, byIp, sessions] = await Promise.all([
    prisma.loginAttempt.count({ where: { email: ADMIN_EMAIL, success: false, createdAt: { gte: since } } }),
    prisma.loginAttempt.groupBy({ by: ["ipAddress"], where: { success: false, createdAt: { gte: since } }, _count: { _all: true } }),
    user ? prisma.session.count({ where: { userId: user.id, expiresAt: { gt: now } } }) : Promise.resolve(0),
  ]);
  return {
    exists: !!user,
    role: user?.role ?? null,
    isActive: user?.isActive ?? null,
    hasPassword: !!user?.passwordHash,
    recentFailures,
    emailLocked: recentFailures >= MAX_FAILURES_PER_EMAIL,
    lockedAddresses: byIp.filter((r) => r._count._all >= MAX_FAILURES_PER_IP).map((r) => r.ipAddress),
    sessions,
  };
}

/** The app's password rule (see passwordSchema in src/lib/validation.ts). Null when acceptable. */
export function passwordProblem(password: string): string | null {
  if (password.length < 10) return "The password must be at least 10 characters.";
  if (password.length > 128) return "The password must be at most 128 characters.";
  if (!/[A-Za-z]/.test(password) || !/\d/.test(password)) return "The password must contain letters and numbers.";
  return null;
}

export type ResetResult = { activated: boolean; isActive: boolean; clearedFailures: number; endedSessions: number };

/**
 * Sets a new password for admin@example.com, and only that account: it must exist and be an Admin
 * (nothing is created and no role changes). In the same transaction it clears that email's failed
 * sign-ins (lifting its lockout), signs it out everywhere and records the reset in the audit log.
 * With `activate`, a deactivated account is switched back on.
 */
export async function resetAdminPassword(prisma: PrismaClient, opts: { password: string; activate?: boolean; now?: Date }): Promise<ResetResult> {
  const problem = passwordProblem(opts.password);
  if (problem) throw new Error(problem);
  const now = opts.now ?? new Date();
  const passwordHash = await bcrypt.hash(opts.password, 12);
  return prisma.$transaction(async (tx) => {
    const user = await tx.user.findUnique({ where: { email: ADMIN_EMAIL }, select: { id: true, name: true, role: true, isActive: true } });
    if (!user) throw new Error(`There is no account ${ADMIN_EMAIL}. Nothing was changed.`);
    if (user.role !== "ADMIN") throw new Error(`${ADMIN_EMAIL} is not an Admin account. Nothing was changed.`);
    const activate = !!opts.activate && !user.isActive;
    await tx.user.update({ where: { id: user.id }, data: { passwordHash, passwordChangedAt: now, ...(activate ? { isActive: true } : {}) } });
    const cleared = await tx.loginAttempt.deleteMany({ where: { email: ADMIN_EMAIL, success: false } });
    const ended = await tx.session.deleteMany({ where: { userId: user.id } });
    await tx.auditLog.create({
      data: {
        entityType: "USER",
        entityId: user.id,
        action: "PASSWORD_RESET_CLI",
        summary: `${user.name}'s password was reset from the server command line`,
        summaryData: { key: "audit.passwordResetCli", params: { name: user.name } },
        changes: activate ? { isActive: { from: false, to: true } } : undefined,
        actorId: null,
        createdAt: now,
      },
    });
    return { activated: activate, isActive: activate || user.isActive, clearedFailures: cleared.count, endedSessions: ended.count };
  });
}

/** "localhost:5433/installation_manager", without user name or password. */
export function describeDatabase(url: string | undefined): string {
  if (!url) return "(DATABASE_URL is not set)";
  try {
    const u = new URL(url);
    return `${u.hostname}:${u.port || "5432"}${u.pathname}`;
  } catch {
    return "(DATABASE_URL could not be read)";
  }
}
