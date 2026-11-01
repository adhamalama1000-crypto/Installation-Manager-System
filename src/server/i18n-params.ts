import "server-only";
import { money } from "@/lib/constants";
import { dayRangeLabel, fmt } from "@/lib/time";

/**
 * Parameters for stored messages (audit summaries, notifications) whose text depends on the
 * reader's language: the English form plus an "<name>Ar" variant (see i18n/translator).
 */
export function moneyParam(name: string, amount: number): Record<string, string> {
  return { [name]: money(amount, "en"), [`${name}Ar`]: money(amount, "ar") };
}

export function whenParam(name: string, startsAt: Date, endsAt: Date, tz: string): Record<string, string> {
  const label = (locale: "en" | "ar") => `${fmt(startsAt, tz, "EEE d MMM yyyy, HH:mm", locale)}–${fmt(endsAt, tz, "HH:mm")}`;
  return { [name]: label("en"), [`${name}Ar`]: label("ar") };
}

export function dateParam(name: string, date: Date | string, tz: string, pattern = "EEE d MMM yyyy"): Record<string, string> {
  return { [name]: fmt(date, tz, pattern, "en"), [`${name}Ar`]: fmt(date, tz, pattern, "ar") };
}

/** A configured status: its name and Arabic name. */
export function statusParam(name: string, s: { name: string; nameAr?: string | null }): Record<string, string> {
  return s.nameAr ? { [name]: s.name, [`${name}Ar`]: s.nameAr } : { [name]: s.name };
}

/** A range of whole days ("Mon 10 Mar – Wed 12 Mar"). */
export function dayRangeParam(name: string, fromKey: string, toKey: string): Record<string, string> {
  return { [name]: dayRangeLabel(fromKey, toKey, "en"), [`${name}Ar`]: dayRangeLabel(fromKey, toKey, "ar") };
}
