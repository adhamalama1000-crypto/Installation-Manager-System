import "server-only";
import { msg } from "@/i18n/translator";
import { DEFAULT_SKU_PREFIX, formatSku, internalEan13, variantCodeCandidates } from "@/lib/product-codes";
import type { Tx } from "../db";
import { formError, nextSequence } from "./inventory-common";

/**
 * Automatic codes for the catalogue. Every number comes from `document_sequences` (one row per
 * prefix, incremented with INSERT … ON CONFLICT DO UPDATE … RETURNING), whose row lock is held
 * until the transaction ends: two people creating products at the same moment are served one
 * after the other and can never get the same number. A number already taken by a hand-typed code
 * is skipped. The unique indexes on products.sku and products.barcode are the final guarantee.
 */

const MAX_TRIES = 500;

/** The SKU prefix for a category: its code, its parent's code, or PRD. */
export async function skuPrefix(tx: Tx, categoryId: string | null | undefined): Promise<string> {
  if (!categoryId) return DEFAULT_SKU_PREFIX;
  const c = await tx.catalogCategory.findUnique({ where: { id: categoryId }, select: { code: true, parent: { select: { code: true } } } });
  return c?.code ?? c?.parent?.code ?? DEFAULT_SKU_PREFIX;
}

async function skuTaken(tx: Tx, sku: string, reserved?: Set<string>): Promise<boolean> {
  if (reserved?.has(sku)) return true;
  return !!(await tx.product.findUnique({ where: { sku }, select: { id: true } }));
}

/** The next free SKU for a category (LCK-00001, PRD-00042, ...). */
export async function nextSku(tx: Tx, categoryId: string | null | undefined, reserved?: Set<string>): Promise<string> {
  const prefix = await skuPrefix(tx, categoryId);
  for (let i = 0; i < MAX_TRIES; i++) {
    const sku = formatSku(prefix, await nextSequence(tx, `SKU:${prefix}`));
    if (!(await skuTaken(tx, sku, reserved))) {
      reserved?.add(sku);
      return sku;
    }
  }
  throw formError("variants.errors.noSku", undefined, "sku");
}

/** A free code for a new variant: PARENT-BLACK, else PARENT-V1, PARENT-V2, ... */
export async function nextVariantCode(tx: Tx, parentSku: string, variantNameEn: string, reserved?: Set<string>): Promise<string> {
  for (const candidate of variantCodeCandidates(parentSku, variantNameEn, MAX_TRIES)) {
    if (!(await skuTaken(tx, candidate, reserved))) {
      reserved?.add(candidate);
      return candidate;
    }
  }
  throw formError("variants.errors.noSku", undefined, "sku");
}

/** The next free internal EAN-13 barcode (2xxxxxxxxxxxC). */
export async function nextInternalBarcode(tx: Tx, reserved?: Set<string>): Promise<string> {
  for (let i = 0; i < MAX_TRIES; i++) {
    const code = internalEan13(await nextSequence(tx, "EAN13:2"));
    if (reserved?.has(code)) continue;
    if (!(await tx.product.findUnique({ where: { barcode: code }, select: { id: true } }))) {
      reserved?.add(code);
      return code;
    }
  }
  throw formError("variants.errors.noBarcodeRange", undefined, "barcode");
}

export const codeErrors = { skuTaken: () => msg("catalog.errors.skuTaken"), barcodeTaken: () => msg("catalog.errors.barcodeTaken") };
