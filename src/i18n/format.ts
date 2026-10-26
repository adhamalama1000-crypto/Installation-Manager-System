/**
 * Locale-aware formatting. Dates and times are always shown in the company timezone (Settings),
 * never the browser's, so everyone sees the same wall-clock time; only the language changes.
 */
import { fmt } from "@/lib/time";
import { INTL_LOCALE, type Locale } from "./config";

const cache = new Map<string, Intl.DateTimeFormat>();

function dtf(locale: Locale, tz: string, options: Intl.DateTimeFormatOptions): Intl.DateTimeFormat {
  const key = `${locale}|${tz}|${JSON.stringify(options)}`;
  let f = cache.get(key);
  if (!f) {
    f = new Intl.DateTimeFormat(INTL_LOCALE[locale], { ...options, timeZone: tz });
    cache.set(key, f);
  }
  return f;
}

const toDate = (d: Date | string) => (typeof d === "string" ? new Date(d) : d);
/** A "yyyy-MM-dd" day key as a UTC instant at noon (formatted with timeZone UTC: no shifting). */
const keyDate = (key: string) => {
  const [y, m, d] = key.split("-").map(Number);
  return new Date(Date.UTC(y!, m! - 1, d!, 12));
};

const TIME: Intl.DateTimeFormatOptions = { hour: "2-digit", minute: "2-digit", hourCycle: "h23" };

export type Formatter = ReturnType<typeof createFormatter>;

export function createFormatter(locale: Locale, tz: string) {
  const intl = INTL_LOCALE[locale];
  const numberFormat = new Intl.NumberFormat(intl, { maximumFractionDigits: 2 });
  const sep = locale === "ar" ? "، " : ", ";
  // English keeps the exact formats the app always used ("Sat 14 Mar 2026"); Arabic uses Intl.
  const en = locale === "en";
  const f = {
    locale,
    tz,
    /** The language's list comma with its space. */
    sep,
    /** 14:30 */
    time: (d: Date | string) => (en ? fmt(d, tz, "HH:mm") : dtf(locale, tz, TIME).format(toDate(d))),
    /** 14:30–16:30 */
    timeRange: (a: Date | string, b: Date | string) => `${f.time(a)}–${f.time(b)}`,
    /** Sat 14 Mar 2026 */
    date: (d: Date | string) => (en ? fmt(d, tz, "EEE d MMM yyyy") : dtf(locale, tz, { weekday: "short", day: "numeric", month: "short", year: "numeric" }).format(toDate(d))),
    /** Saturday 14 March 2026 */
    longDate: (d: Date | string) => (en ? fmt(d, tz, "EEEE d MMMM yyyy") : dtf(locale, tz, { weekday: "long", day: "numeric", month: "long", year: "numeric" }).format(toDate(d))),
    /** 14 Mar 2026 */
    shortDate: (d: Date | string) => (en ? fmt(d, tz, "d MMM yyyy") : dtf(locale, tz, { day: "numeric", month: "short", year: "numeric" }).format(toDate(d))),
    /** 14 Mar 2026, 14:30 */
    dateTime: (d: Date | string) => `${f.shortDate(d)}${sep}${f.time(d)}`,
    /** Sat 14 Mar 2026, 14:30–16:30 */
    when: (a: Date | string, b: Date | string) => `${f.date(a)}${sep}${f.timeRange(a, b)}`,
    /** Day keys ("2026-03-14") are calendar days, formatted without any timezone shift. */
    day: (key: string, options: Intl.DateTimeFormatOptions = { weekday: "short", day: "numeric", month: "short" }) =>
      dtf(locale, "UTC", options).format(keyDate(key)),
    dayLong: (key: string) => dtf(locale, "UTC", { weekday: "long", day: "numeric", month: "long", year: "numeric" }).format(keyDate(key)),
    dayRange: (from: string, to: string) => (from === to ? f.day(from) : `${f.day(from)} – ${f.day(to)}`),
    month: (key: string) => dtf(locale, "UTC", { month: "long", year: "numeric" }).format(keyDate(key.length === 7 ? `${key}-01` : key)),
    weekday: (index: number, style: "long" | "short" = "long") => dtf(locale, "UTC", { weekday: style }).format(new Date(Date.UTC(2024, 0, 7 + index, 12))),
    number: (n: number) => numberFormat.format(n),
    /** Egyptian pounds: "1,250 EGP" / "1,250 ج.م" */
    money: (n: number | null | undefined) => {
      if (n === null || n === undefined) return "—";
      const s = new Intl.NumberFormat(intl, { minimumFractionDigits: Number.isInteger(n) ? 0 : 2, maximumFractionDigits: 2 }).format(n);
      return locale === "ar" ? `${s} ج.م` : `${s} EGP`;
    },
    /** Joins parts with the language's comma ("a, b" / "a، b"). */
    join: (items: (string | null | undefined | false)[]) => items.filter(Boolean).join(sep),
    list: (items: string[]) => new Intl.ListFormat(intl, { style: "long", type: "conjunction" }).format(items),
    minutes: (total: number) => {
      const h = Math.floor(total / 60);
      const m = total % 60;
      if (locale === "ar") return [h ? `${h} س` : "", m ? `${m} د` : ""].filter(Boolean).join(" ") || "0 د";
      return [h ? `${h} h` : "", m ? `${m} min` : ""].filter(Boolean).join(" ") || "0 min";
    },
  };
  return f;
}
