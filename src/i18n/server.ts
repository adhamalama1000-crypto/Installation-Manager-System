import "server-only";
import { cookies, headers } from "next/headers";
import { cache } from "react";
import { DEFAULT_TIMEZONE } from "@/lib/constants";
import { getCurrentUser } from "@/server/auth/session";
import { DEFAULT_LOCALE, LOCALE_COOKIE, dirOf, isLocale, localeFromAcceptLanguage, type Locale } from "./config";
import { createFormatter } from "./format";
import { enumLabel, localName, translate, translateMessage, type EnumType, type MessageKey, type Params } from "./translate";

/**
 * The reader's language: the language saved on their account, else this device's choice (cookie),
 * else the browser's preference, else Arabic.
 */
export function resolveLocale(input: { userLocale?: string | null; cookie?: string | null; acceptLanguage?: string | null }): Locale {
  if (isLocale(input.userLocale)) return input.userLocale;
  if (isLocale(input.cookie)) return input.cookie;
  return localeFromAcceptLanguage(input.acceptLanguage) ?? DEFAULT_LOCALE;
}

function cookieValue(header: string | null, name: string): string | null {
  for (const part of (header ?? "").split(";")) {
    const [k, ...rest] = part.trim().split("=");
    if (k === name) return decodeURIComponent(rest.join("="));
  }
  return null;
}

/** For route handlers. */
export function localeFromRequest(req: Request, userLocale?: string | null): Locale {
  return resolveLocale({ userLocale, cookie: cookieValue(req.headers.get("cookie"), LOCALE_COOKIE), acceptLanguage: req.headers.get("accept-language") });
}

export const getLocale = cache(async (): Promise<Locale> => {
  const [user, store, h] = await Promise.all([getCurrentUser(), cookies(), headers()]);
  return resolveLocale({ userLocale: user?.locale, cookie: store.get(LOCALE_COOKIE)?.value, acceptLanguage: h.get("accept-language") });
});

/** Translation and formatting for server components (cached per request). */
export const getI18n = cache(async () => {
  const [locale, user] = await Promise.all([getLocale(), getCurrentUser()]);
  const tz = user?.settings.timezone ?? DEFAULT_TIMEZONE;
  return {
    locale,
    tz,
    dir: dirOf(locale),
    t: (key: MessageKey, params?: Params) => translate(locale, key, params, tz),
    tm: (text: string | null | undefined) => translateMessage(text, locale, tz),
    f: createFormatter(locale, tz),
    label: (type: EnumType, value: string) => enumLabel(locale, type, value),
    sn: (item: { name: string; nameAr?: string | null }) => localName(locale, item),
  };
});

export type ServerI18n = Awaited<ReturnType<typeof getI18n>>;
