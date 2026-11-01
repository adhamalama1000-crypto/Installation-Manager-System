import { NextResponse } from "next/server";
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

  if (await isLoginBlocked(email, ip)) throw new RateLimitError();

  const user = await prisma.user.findUnique({ where: { email } });
  const ok = await verifyPassword(password, user?.passwordHash);
  if (!user || !ok || !user.isActive) {
    await recordLoginAttempt(email, ip, false);
    // Same message for unknown email, wrong password and inactive account.
    throw new UnauthorizedError("auth.invalid");
  }
  await recordLoginAttempt(email, ip, true);
  const { token, expiresAt } = await createSession(user.id, { userAgent: req.headers.get("user-agent"), ipAddress: ip });
  const res = NextResponse.json({ ok: true, user: { id: user.id, name: user.name, role: user.role } });
  res.cookies.set(sessionCookie(token, expiresAt));
  // A language already chosen in this browser (e.g. on the sign-in page) stays; otherwise the
  // language the user chose before, on any device, comes back with them.
  const chosenHere = isLocale(cookieFromHeader(req.headers.get("cookie"), LOCALE_COOKIE));
  if (!chosenHere && isLocale(user.locale)) res.cookies.set(localeCookie(user.locale));
  return res;
});
