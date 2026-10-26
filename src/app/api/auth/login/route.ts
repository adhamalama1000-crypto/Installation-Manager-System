import { NextResponse } from "next/server";
import { fieldErrorsFromZod, loginSchema } from "@/lib/validation";
import { prisma } from "@/server/db";
import { RateLimitError, UnauthorizedError, ValidationError } from "@/server/errors";
import { publicRoute } from "@/server/http";
import { readJson } from "@/server/http";
import { verifyPassword } from "@/server/auth/password";
import { clientIp, isLoginBlocked, recordLoginAttempt } from "@/server/auth/rate-limit";
import { createSession, sessionCookie } from "@/server/auth/session";
import { LOCALE_COOKIE, isLocale } from "@/i18n/config";
import { msg } from "@/i18n/translate";
import { localeCookie } from "@/server/auth/locale-cookie";

export const POST = publicRoute(async ({ req }) => {
  const parsed = loginSchema.safeParse(await readJson(req));
  if (!parsed.success) throw new ValidationError(fieldErrorsFromZod(parsed.error));
  const { email, password } = parsed.data;
  const ip = clientIp(req);

  if (await isLoginBlocked(email, ip)) throw new RateLimitError();

  const user = await prisma.user.findUnique({ where: { email } });
  const ok = await verifyPassword(password, user?.passwordHash);
  if (!user || !ok || !user.isActive) {
    await recordLoginAttempt(email, ip, false);
    // Same message for unknown email, wrong password and inactive account.
    throw new UnauthorizedError(msg("e.invalidCredentials"));
  }
  await recordLoginAttempt(email, ip, true);
  const { token, expiresAt } = await createSession(user.id, { userAgent: req.headers.get("user-agent"), ipAddress: ip });
  const res = NextResponse.json({ ok: true, user: { id: user.id, name: user.name, role: user.role } });
  res.cookies.set(sessionCookie(token, expiresAt));
  // The language picked on the sign-in page becomes the account's language; otherwise the
  // account's saved language is applied to this device.
  const chosen = req.headers.get("cookie")?.match(new RegExp(`(?:^|;\\s*)${LOCALE_COOKIE}=(ar|en)`))?.[1];
  if (chosen && chosen !== user.locale) await prisma.user.update({ where: { id: user.id }, data: { locale: chosen } });
  else if (!chosen && isLocale(user.locale)) res.cookies.set(localeCookie(user.locale));
  return res;
});
