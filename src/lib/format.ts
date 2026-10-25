import { PRODUCT_CATEGORY_LABELS, VISIT_TYPE_LABELS } from "./constants";
import { fmt } from "./time";
import type { ProductCategory, VisitType } from "@prisma/client";

export function timeRange(startsAt: string | Date, endsAt: string | Date, tz: string) {
  return `${fmt(startsAt, tz, "HH:mm")}–${fmt(endsAt, tz, "HH:mm")}`;
}

export function longDate(d: string | Date, tz: string) {
  return fmt(d, tz, "EEEE d MMMM yyyy");
}

export function shortDate(d: string | Date, tz: string) {
  return fmt(d, tz, "EEE d MMM yyyy");
}

export function dateTime(d: string | Date, tz: string) {
  return fmt(d, tz, "d MMM yyyy, HH:mm");
}

export function categoryText(a: { productCategory: ProductCategory; categoryOther: string | null }) {
  return a.productCategory === "OTHER" && a.categoryOther ? a.categoryOther : PRODUCT_CATEGORY_LABELS[a.productCategory];
}

export function productLine(a: { productCategory: ProductCategory; categoryOther: string | null; brand: string | null; model: string | null; visitType?: VisitType | null }) {
  const kind = a.visitType ? `${VISIT_TYPE_LABELS[a.visitType]}: ${categoryText(a)}` : categoryText(a);
  return [kind, [a.brand, a.model].filter(Boolean).join(" ")].filter(Boolean).join(" · ");
}
