import { NextResponse } from "next/server";
import { msg } from "@/i18n/translator";
import { recordAudit } from "@/server/services/audit";
import { fieldErrorsFromZod, loginSchema } from "@/lib/validation";
import { addressKey, loginLimits } from "@/lib/login-limits";
import { prisma } from "@/server/db";
import { RateLimitError, ServiceUnavailableError, UnauthorizedError, ValidationError } from "@/server/errors";
import { publicRoute, readJson } from "@/server/http";
import { verifyPassword } from "@/server/auth/password";
import { getHashPool, HashPoolBusyError, HashPoolFailureError } from "@/server/auth/hash-pool";
import { UNKNOWN_ADDRESS } from "@/server/auth/client-ip";
import { claimOnce, clientIp, recordLoginAttempt, releaseLoginAttempt, reserveLoginAttempt, settleLoginSuccess, type LimitScope } from "@/server/auth/rate-limit";
import { cookieFromHeader, createSession, sessionCookie } from "@/server/auth/session";
import { isLocale, LOCALE_COOKIE } from "@/i18n/config";
import { localeCookie } from "@/server/locale";

/**
 * Sign-in. Order matters for abuse resistance:
 *   1. the password pool must have room (else 503 at once: no database work, no counting);
 *   2. a limit slot is taken atomically (src/server/auth/rate-limit.ts; else 429);
 *   3. the password is checked on a worker thread (unknown accounts against a dummy hash, so they
 *      cost the same and answer the same);
 *   4. the outcome is recorded and audited (bounded, see below), then the session is created.
 *
 * Audit entries (append-only, written before the response so none is lost):
 *   - LOGIN_SUCCEEDED for every sign-in;
 *   - LOGIN_FAILED for every failure on an existing account (at most the per-account limit per
 *     window per account, because further attempts are refused before the password is checked);
 *   - LOGIN_FAILED for an unknown email only once per client address per window: every attempt is
 *     still in login_attempts, but a flood of made-up emails cannot flood the audit log;
 *   - LOGIN_BLOCKED once per account / address per window, and once per 15 minutes for the global
 *     limit, however many requests are refused.
 */
async function auditBlocked(scope: LimitScope, email: string, ip: string, firstBlock: boolean) {
  if (!firstBlock) return;
  if (scope === "account") {
    await recordAudit(prisma, { entityType: "AUTH", entityId: email.slice(0, 254), action: "LOGIN_BLOCKED", summary: msg("authAudit.loginBlocked", { email }), changes: { email, scope }, actorId: null });
  } else if (scope === "address") {
    await recordAudit(prisma, { entityType: "AUTH", entityId: addressKey(ip), action: "LOGIN_BLOCKED", summary: msg("authAudit.loginBlockedAddress", { ip }), changes: { ip, scope }, actorId: null });
  } else if (await claimOnce("audit:blocked:global", 15)) {
    await recordAudit(prisma, { entityType: "AUTH", entityId: "global", action: "LOGIN_BLOCKED", summary: msg("authAudit.loginBlockedGlobal"), changes: { scope, limitPerMinute: loginLimits().globalPerMinute }, actorId: null });
  }
}

const busy = () => new ServiceUnavailableError("errors.authBusy", 5);

export const POST = publicRoute(async ({ req }) => {
  const parsed = loginSchema.safeParse(await readJson(req));
  if (!parsed.success) throw new ValidationError(fieldErrorsFromZod(parsed.error));
  const { email, password } = parsed.data;
  const ip = clientIp(req);
  const userAgent = req.headers.get("user-agent");

  // 1. Refuse at once when the password pool is saturated (cheap, and does not depend on the account).
  if (!getHashPool().hasCapacity()) throw busy();

  // 2. Limits. Counters that cannot be reached refuse the sign-in rather than skip the limits.
  let reserved: Awaited<ReturnType<typeof reserveLoginAttempt>>;
  try {
    reserved = await reserveLoginAttempt(email, ip);
  } catch (e) {
    console.error("[auth] sign-in limits unavailable:", e instanceof Error ? e.name : "error");
    throw busy();
  }
  if (!reserved.ok) {
    await auditBlocked(reserved.scope, email, ip, reserved.firstBlock);
    throw new RateLimitError("errors.rateLimited", reserved.retryAfterSeconds);
  }
  const { reservation } = reserved;

  // 3. Password check on the worker pool.
  let user: Awaited<ReturnType<typeof prisma.user.findUnique>>;
  let ok: boolean;
  try {
    user = await prisma.user.findUnique({ where: { email } });
    ok = await verifyPassword(password, user?.passwordHash);
  } catch (e) {
    // Not the user's fault: the attempt does not count against anyone.
    await releaseLoginAttempt(reservation).catch(() => undefined);
    if (e instanceof HashPoolBusyError || e instanceof HashPoolFailureError) throw busy();
    throw e;
  }

  // 4. Outcome.
  if (!user || !ok || !user.isActive) {
    const outcome = !user ? "UNKNOWN_ACCOUNT" : !ok ? "BAD_PASSWORD" : "INACTIVE";
    await recordLoginAttempt(email, ip, outcome, userAgent);
    // The audit log says why (for the Admin); the person signing in gets one generic message.
    if (user) {
      await recordAudit(prisma, {
        entityType: "AUTH",
        entityId: user.id,
        action: "LOGIN_FAILED",
        summary: msg("authAudit.loginFailed", { email }),
        changes: { email, cause: !ok ? "wrong password" : "inactive account" },
        actorId: user.id,
      });
    } else if (await claimOnce(`audit:unknown:${ip === UNKNOWN_ADDRESS ? ip : addressKey(ip)}`, loginLimits().windowMinutes)) {
      await recordAudit(prisma, {
        entityType: "AUTH",
        entityId: email.slice(0, 254),
        action: "LOGIN_FAILED",
        summary: msg("authAudit.loginFailedUnknown", { ip }),
        changes: { email, cause: "unknown account", aggregated: true },
        actorId: null,
      });
    }
    // Same message for unknown email, wrong password and inactive account.
    throw new UnauthorizedError("auth.invalid");
  }
  await settleLoginSuccess(reservation);
  await recordLoginAttempt(email, ip, "SUCCESS", userAgent);
  await recordAudit(prisma, { entityType: "AUTH", entityId: user.id, action: "LOGIN_SUCCEEDED", summary: msg("authAudit.loginSucceeded", { name: user.name }), changes: { email }, actorId: user.id });
  const { token, expiresAt } = await createSession(user.id, { userAgent, ipAddress: ip });
  const res = NextResponse.json({ ok: true, user: { id: user.id, name: user.name, role: user.role } });
  res.cookies.set(sessionCookie(token, expiresAt, req));
  // A language already chosen in this browser (e.g. on the sign-in page) stays; otherwise the
  // language the user chose before, on any device, comes back with them.
  const chosenHere = isLocale(cookieFromHeader(req.headers.get("cookie"), LOCALE_COOKIE));
  if (!chosenHere && isLocale(user.locale)) res.cookies.set(localeCookie(user.locale, req));
  return res;
});
