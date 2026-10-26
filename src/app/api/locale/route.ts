import { NextResponse } from "next/server";
import { z } from "zod";
import { LOCALES } from "@/i18n/config";
import { msg } from "@/i18n/translate";
import { prisma } from "@/server/db";
import { ValidationError } from "@/server/errors";
import { publicRoute, readJson } from "@/server/http";
import { getUserFromRequest } from "@/server/auth/session";
import { localeCookie } from "@/server/auth/locale-cookie";

const schema = z.object({ locale: z.enum(LOCALES) });

/**
 * Switches the interface language: remembered on this device (cookie) and, when signed in, saved
 * on the account so every device and the next sign-in use it too. Works on the sign-in page.
 */
export const POST = publicRoute(async ({ req }) => {
  const parsed = schema.safeParse(await readJson(req));
  if (!parsed.success) throw new ValidationError({ locale: msg("v.chooseOne") });
  const { locale } = parsed.data;
  const user = await getUserFromRequest(req);
  if (user && user.locale !== locale) {
    await prisma.user.update({ where: { id: user.id }, data: { locale } });
  }
  const res = NextResponse.json({ ok: true, locale });
  res.cookies.set(localeCookie(locale));
  return res;
});
