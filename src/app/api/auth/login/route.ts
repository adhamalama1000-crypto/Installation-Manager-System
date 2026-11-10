import { NextResponse } from "next/server";
import { msg } from "@/i18n/translator";
import { recordAudit } from "@/server/services/audit";
import { fieldErrorsFromZod, loginSchema } from "@/lib/validation";
import { prisma } from "@/server/db";
import { RateLimitError, UnauthorizedError, ValidationError } from "@/server/errors";
import { publicRoute } from "@/server/http";
import { readJson } from "@/server/http";
import { verifyPassword } from "@/server/auth/password";
import { clientIp, isLoginBlocked, recordLoginAttempt } from "@/server/auth/rate-limit";
import { cookieFromHeader, createSession, sessionCookie } from "@/server/auth/session";
import { isLocale, LOCALE_COOKIE } from "@/i18n/config";
import { localeCookie } from "@/server/locale";

export const POST = publicRoute(async ({ req }) => {
  const parsed = loginSchema.safeParse(await readJson(req));
  if (!parsed.success) throw new ValidationError(fieldErrorsFromZod(parsed.error));
  const { email, password } = parsed.data;
  const ip = clientIp(req);

  if (await isLoginBlocked(email, ip)) {
    await recordAudit(prisma, { entityType: "AUTH", entityId: email.slice(0, 254), action: "LOGIN_BLOCKED", summary: msg("authAudit.loginBlocked", { email }), changes: { email }, actorId: null });
    throw new RateLimitError();
  }

  const user = await prisma.user.findUnique({ where: { email } });
  const ok = await verifyPassword(password, user?.passwordHash);
  if (!user || !ok || !user.isActive) {
    await recordLoginAttempt(email, ip, false);
    // The audit log says why (for the Admin); the person signing in gets one generic message.
    await recordAudit(prisma, {
      entityType: "AUTH",
      entityId: user?.id ?? email.slice(0, 254),
      action: "LOGIN_FAILED",
      summary: msg("authAudit.loginFailed", { email }),
      changes: { email, cause: !user ? "unknown account" : !ok ? "wrong password" : "inactive account" },
      actorId: user?.id ?? null,
    });
    // Same message for unknown email, wrong password and inactive account.
    throw new UnauthorizedError("auth.invalid");
  }
  await recordLoginAttempt(email, ip, true);
  await recordAudit(prisma, { entityType: "AUTH", entityId: user.id, action: "LOGIN_SUCCEEDED", summary: msg("authAudit.loginSucceeded", { name: user.name }), changes: { email }, actorId: user.id });
  const { token, expiresAt } = await createSession(user.id, { userAgent: req.headers.get("user-agent"), ipAddress: ip });
  const res = NextResponse.json({ ok: true, user: { id: user.id, name: user.name, role: user.role } });
  res.cookies.set(sessionCookie(token, expiresAt, req));
  // A language already chosen in this browser (e.g. on the sign-in page) stays; otherwise the
  // language the user chose before, on any device, comes back with them.
  const chosenHere = isLocale(cookieFromHeader(req.headers.get("cookie"), LOCALE_COOKIE));
  if (!chosenHere && isLocale(user.locale)) res.cookies.set(localeCookie(user.locale, req));
  return res;
});
