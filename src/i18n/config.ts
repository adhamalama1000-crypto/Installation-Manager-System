/** Supported interface languages. Arabic is the default; English is the alternative. */
export const LOCALES = ["ar", "en"] as const;
export type Locale = (typeof LOCALES)[number];
export const DEFAULT_LOCALE: Locale = "ar";
/** Cookie holding the chosen language (one year). */
export const LOCALE_COOKIE = "ims_locale";

export function isLocale(value: unknown): value is Locale {
  return value === "ar" || value === "en";
}

export function dirOf(locale: Locale): "rtl" | "ltr" {
  return locale === "ar" ? "rtl" : "ltr";
}

/**
 * Locale used with Intl. Arabic keeps Western digits ("nu-latn") so phone numbers, appointment
 * codes, serials and amounts read the same everywhere (as in the original Aura app).
 */
export function intlLocale(locale: Locale): string {
  return locale === "ar" ? "ar-EG-u-nu-latn" : "en-GB";
}

/** Reads the language from a Cookie header (API routes and anything without next/headers). */
export function localeFromCookieHeader(header: string | null | undefined): Locale {
  const m = /(?:^|;\s*)ims_locale=(ar|en)(?:;|$)/.exec(header ?? "");
  return (m?.[1] as Locale | undefined) ?? DEFAULT_LOCALE;
}
