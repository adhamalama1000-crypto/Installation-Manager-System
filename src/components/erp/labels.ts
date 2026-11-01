import type { StockDocType, StockReturnKind } from "@prisma/client";
import type { T } from "@/i18n/translator";

/** "Goods receipt", "Customer return", ... */
export function docTypeLabel(t: T, type: StockDocType, returnKind: StockReturnKind | null | undefined): string {
  return type === "RETURN" && returnKind ? t.dyn(`enums.stockDocType.RETURN_${returnKind}`) : t.dyn(`enums.stockDocType.${type}`);
}

/** A name in the reader's language. */
export function nameOf(x: { nameEn: string; nameAr: string }, t: T): string {
  return t.locale === "ar" ? x.nameAr || x.nameEn : x.nameEn || x.nameAr;
}

export const control = "h-10 w-full rounded-lg border border-line-strong bg-surface px-3 text-sm text-fg";
export const submitBtn = "h-10 rounded-lg bg-brand-strong px-4 text-sm font-semibold text-white hover:bg-brand-stronger";
export const th = "px-4 py-2 text-start font-medium";
export const thEnd = "px-4 py-2 text-end font-medium";
export const tableHead = "bg-surface-muted/60 text-start text-xs uppercase tracking-wide text-fg-muted";
