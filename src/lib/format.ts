import type { ProductCategory, VisitType } from "@prisma/client";
import type { Locale } from "@/i18n/config";
import type { T } from "@/i18n/translator";
import { fmt } from "./time";

export function timeRange(startsAt: string | Date, endsAt: string | Date, tz: string) {
  return `${fmt(startsAt, tz, "HH:mm")}–${fmt(endsAt, tz, "HH:mm")}`;
}

export function longDate(d: string | Date, tz: string, locale: Locale) {
  return fmt(d, tz, "EEEE d MMMM yyyy", locale);
}

export function shortDate(d: string | Date, tz: string, locale: Locale) {
  return fmt(d, tz, "EEE d MMM yyyy", locale);
}

export function dateTime(d: string | Date, tz: string, locale: Locale) {
  return fmt(d, tz, "d MMM yyyy, HH:mm", locale);
}

export function categoryText(a: { productCategory: ProductCategory; categoryOther: string | null }, t: T) {
  return a.productCategory === "OTHER" && a.categoryOther ? a.categoryOther : t.dyn(`enums.productCategory.${a.productCategory}`);
}

export function productLine(
  a: { productCategory: ProductCategory; categoryOther: string | null; brand: string | null; model: string | null; visitType?: VisitType | null },
  t: T,
) {
  const kind = a.visitType ? `${t.dyn(`enums.visitType.${a.visitType}`)}: ${categoryText(a, t)}` : categoryText(a, t);
  return [kind, [a.brand, a.model].filter(Boolean).join(" ")].filter(Boolean).join(" · ");
}

/** An admin-configured status in the reader's language (Arabic name when one was entered). */
export function statusName(s: { name: string; nameAr?: string | null }, locale: Locale) {
  return locale === "ar" && s.nameAr ? s.nameAr : s.name;
}
