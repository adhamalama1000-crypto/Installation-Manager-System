import type { ProductCategory, VisitType } from "@prisma/client";
import type { EnumType } from "@/i18n/translate";

/** Enum label lookup of the current language (`useI18n().label` / `getI18n().label`). */
export type LabelFn = (type: EnumType, value: string) => string;

export function categoryText(a: { productCategory: ProductCategory; categoryOther: string | null }, label: LabelFn) {
  return a.productCategory === "OTHER" && a.categoryOther ? a.categoryOther : label("category", a.productCategory);
}

/** "Installation: Smart Lock · Yale Linus" in the reader's language. */
export function productLine(
  a: { productCategory: ProductCategory; categoryOther: string | null; brand: string | null; model: string | null; visitType?: VisitType | null },
  label: LabelFn,
) {
  const kind = a.visitType ? `${label("visitType", a.visitType)}: ${categoryText(a, label)}` : categoryText(a, label);
  return [kind, [a.brand, a.model].filter(Boolean).join(" ")].filter(Boolean).join(" · ");
}
