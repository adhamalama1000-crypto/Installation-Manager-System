import { msg } from "@/i18n/translator";
import { NextResponse } from "next/server";
import { z } from "zod";
import { LOCALES } from "@/i18n/config";
import { prisma } from "@/server/db";
import { ValidationError } from "@/server/errors";
import { publicRoute, readJson } from "@/server/http";
import { getUserFromRequest } from "@/server/auth/session";
import { localeCookie } from "@/server/locale";

const schema = z.object({ locale: z.enum(LOCALES) });

/** Switches the interface language: sets the cookie and, when signed in, saves the preference. */
export const POST = publicRoute(async ({ req }) => {
  const parsed = schema.safeParse(await readJson(req));
  if (!parsed.success) throw new ValidationError({ locale: msg("validation.invalid") });
  const user = await getUserFromRequest(req);
  if (user) await prisma.user.update({ where: { id: user.id }, data: { locale: parsed.data.locale } });
  const res = NextResponse.json({ ok: true, locale: parsed.data.locale });
  res.cookies.set(localeCookie(parsed.data.locale));
  return res;
});
