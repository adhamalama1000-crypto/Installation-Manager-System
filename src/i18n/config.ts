/**
 * Supported languages. The locale is chosen per user (saved on the account), remembered in a
 * cookie for the device, and otherwise taken from the browser; URLs never change with the language.
 */
export const LOCALES = ["ar", "en"] as const;
export type Locale = (typeof LOCALES)[number];

/** First-time visitors whose browser prefers neither language see Arabic (the team's language). */
export const DEFAULT_LOCALE: Locale = "ar";

export const LOCALE_COOKIE = "aura_locale";

export function isLocale(value: unknown): value is Locale {
  return typeof value === "string" && (LOCALES as readonly string[]).includes(value);
}

export function dirOf(locale: Locale): "rtl" | "ltr" {
  return locale === "ar" ? "rtl" : "ltr";
}

/**
 * BCP 47 tags for Intl. Arabic keeps Latin digits: phone numbers, serials, codes and amounts are
 * typed and read in Latin digits by the team, and mixing digit systems on one screen causes mistakes.
 */
export const INTL_LOCALE: Record<Locale, string> = {
  ar: "ar-EG-u-nu-latn",
  en: "en-GB",
};

export const LOCALE_NAMES: Record<Locale, string> = { ar: "العربية", en: "English" };

/** Picks the best supported language from an Accept-Language header (null when none matches). */
export function localeFromAcceptLanguage(header: string | null | undefined): Locale | null {
  if (!header) return null;
  const prefs = header
    .split(",")
    .map((part) => {
      const [tag, ...params] = part.trim().split(";");
      const q = params.map((p) => p.trim()).find((p) => p.startsWith("q="));
      return { lang: (tag ?? "").toLowerCase().split("-")[0]!, q: q ? Number(q.slice(2)) || 0 : 1 };
    })
    .filter((p) => p.lang && p.q > 0)
    .sort((a, b) => b.q - a.q);
  for (const p of prefs) if (isLocale(p.lang)) return p.lang;
  return null;
}
