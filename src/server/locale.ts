import "server-only";
import { LOCALE_COOKIE, type Locale } from "@/i18n/config";
import { isSecureRequest } from "./auth/session";

/** The language cookie: readable by the server on every request, kept for a year. */
export function localeCookie(locale: Locale, req: Request) {
  return {
    name: LOCALE_COOKIE,
    value: locale,
    httpOnly: true,
    sameSite: "lax" as const,
    secure: isSecureRequest(req),
    path: "/",
    maxAge: 365 * 24 * 60 * 60,
  };
}
