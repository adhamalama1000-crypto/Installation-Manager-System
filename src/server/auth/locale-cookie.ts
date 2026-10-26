import "server-only";
import { LOCALE_COOKIE } from "@/i18n/config";
import { secureCookies } from "./session";

/** The device's interface language (not secret, so readable by scripts; one year). */
export function localeCookie(locale: string) {
  return { name: LOCALE_COOKIE, value: locale, path: "/", sameSite: "lax" as const, secure: secureCookies(), maxAge: 365 * 24 * 3600 };
}
