import { msg } from "@/i18n/translator";
import { loginLimits, passwordChangeKey } from "@/lib/login-limits";
import { changePasswordSchema, fieldErrorsFromZod } from "@/lib/validation";
import { prisma } from "@/server/db";
import { RateLimitError, ServiceUnavailableError, StaleRecordError, ValidationError } from "@/server/errors";
import { apiRoute, readJson } from "@/server/http";
import { hashPassword, verifyPassword } from "@/server/auth/password";
import { HashPoolBusyError, HashPoolFailureError } from "@/server/auth/hash-pool";
import { clearSlot, releaseSlot, takeSlot } from "@/server/auth/rate-limit";
import { deleteUserSessions } from "@/server/auth/session";
import { recordAudit } from "@/server/services/audit";

/**
 * Changes the signed-in user's password. Guarded like the sign-in, because a stolen session could
 * otherwise be used to guess the current password:
 *   - LOGIN_MAX_FAILURES_PER_ACCOUNT attempts per user per LOGIN_FAILURE_WINDOW_MINUTES (shared by
 *     every app instance, taken atomically); then 429 with Retry-After until the window ends;
 *   - every wrong current password is audited (USER_PASSWORD_CHANGE_FAILED), the lock once
 *     (USER_PASSWORD_CHANGE_BLOCKED); never with a password or hash;
 *   - the checks use the password pool's priority lane with this user as the client, so one user
 *     holds at most a few places and cannot starve the sign-in;
 *   - the new hash is written only if the stored one is still the one that was checked, so two
 *     simultaneous changes cannot both succeed (the second gets 409);
 *   - a successful change signs out every other session of the user (as before).
 * When the limit counters cannot be reached the change is refused (503), never let through.
 */
export const POST = apiRoute(async ({ req, user }) => {
  const parsed = changePasswordSchema.safeParse(await readJson(req));
  if (!parsed.success) throw new ValidationError(fieldErrorsFromZod(parsed.error));
  const limits = loginLimits();
  const job = { lane: "priority" as const, client: `user:${user.id}` };

  let taken: Awaited<ReturnType<typeof takeSlot>>;
  try {
    taken = await takeSlot(passwordChangeKey(user.id), limits.perAccount, limits.windowMinutes);
  } catch (e) {
    console.error("[auth] password-change limits unavailable:", e instanceof Error ? e.name : "error");
    throw new ServiceUnavailableError("errors.authBusy", 5);
  }
  if (!taken.ok) {
    if (taken.firstBlock) {
      await recordAudit(prisma, { entityType: "USER", entityId: user.id, action: "USER_PASSWORD_CHANGE_BLOCKED", summary: msg("audit.passwordChangeBlocked", { name: user.name }), actorId: user.id });
    }
    throw new RateLimitError("errors.rateLimited", taken.retryAfterSeconds);
  }
  const slot = taken.slot;

  const row = await prisma.user.findUniqueOrThrow({ where: { id: user.id }, select: { passwordHash: true } });
  let ok: boolean;
  let newHash: string | null = null;
  try {
    ok = await verifyPassword(parsed.data.currentPassword, row.passwordHash, job);
    if (ok) newHash = await hashPassword(parsed.data.newPassword, job);
  } catch (e) {
    // Not the user's fault: the attempt does not count.
    await releaseSlot(slot).catch(() => undefined);
    if (e instanceof HashPoolBusyError || e instanceof HashPoolFailureError) throw new ServiceUnavailableError("errors.authBusy", 5);
    throw e;
  }
  if (!ok || !newHash) {
    await recordAudit(prisma, { entityType: "USER", entityId: user.id, action: "USER_PASSWORD_CHANGE_FAILED", summary: msg("audit.passwordChangeFailed", { name: user.name }), actorId: user.id });
    throw new ValidationError({ currentPassword: msg("userErrors.wrongPassword") });
  }

  // Compare-and-swap: only if nobody changed the password since it was checked above.
  const changed = await prisma.user.updateMany({
    where: { id: user.id, passwordHash: row.passwordHash },
    data: { passwordHash: newHash, passwordChangedAt: new Date() },
  });
  if (changed.count !== 1) throw new StaleRecordError("userErrors.passwordChangedMeanwhile");
  await clearSlot(slot).catch(() => undefined);
  await recordAudit(prisma, {
    entityType: "USER",
    entityId: user.id,
    action: "USER_PASSWORD_CHANGED",
    summary: msg("audit.passwordChanged", { name: user.name }),
    actorId: user.id,
  });
  // Sign out every other device.
  await deleteUserSessions(user.id, user.sessionId);
  return { ok: true };
});
