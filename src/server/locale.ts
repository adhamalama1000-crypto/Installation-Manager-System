import "server-only";
import { LOCALE_COOKIE, type Locale } from "@/i18n/config";
import { secureCookies } from "./auth/session";

/** The language cookie: readable by the server on every request, kept for a year. */
export function localeCookie(locale: Locale) {
  return {
    name: LOCALE_COOKIE,
    value: locale,
    httpOnly: true,
    sameSite: "lax" as const,
    secure: secureCookies(),
    path: "/",
    maxAge: 365 * 24 * 60 * 60,
  };
}
