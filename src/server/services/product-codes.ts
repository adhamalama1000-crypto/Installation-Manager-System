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

/** Reserves `count` numbers of a counter at once: the last number after the reservation. */
async function reserve(tx: Tx, key: string, count: number): Promise<number> {
  const rows = await tx.$queryRaw<{ lastNumber: number }[]>`
    INSERT INTO "document_sequences" ("key", "lastNumber") VALUES (${key}, ${count})
    ON CONFLICT ("key") DO UPDATE SET "lastNumber" = "document_sequences"."lastNumber" + ${count}
    RETURNING "lastNumber"`;
  return rows[0]!.lastNumber;
}

/**
 * `count` free SKUs for one category prefix at once (bulk import): one counter update and one
 * look-up for the whole block instead of two statements per product; numbers already taken by
 * hand-typed codes are skipped and topped up one by one.
 */
export async function reserveSkus(tx: Tx, prefix: string, count: number, reserved: Set<string>): Promise<string[]> {
  if (count <= 0) return [];
  const last = await reserve(tx, `SKU:${prefix}`, count);
  const block = Array.from({ length: count }, (_, i) => formatSku(prefix, last - count + 1 + i));
  const taken = new Set((await tx.product.findMany({ where: { sku: { in: block } }, select: { sku: true } })).map((p) => p.sku));
  const out = block.filter((c) => !taken.has(c) && !reserved.has(c));
  for (const c of out) reserved.add(c);
  while (out.length < count) {
    const sku = formatSku(prefix, await nextSequence(tx, `SKU:${prefix}`));
    if (!reserved.has(sku) && !(await tx.product.findUnique({ where: { sku }, select: { id: true } }))) {
      reserved.add(sku);
      out.push(sku);
    }
  }
  return out;
}

/** `count` free internal barcodes at once (bulk import). */
export async function reserveBarcodes(tx: Tx, count: number, reserved: Set<string>): Promise<string[]> {
  if (count <= 0) return [];
  const last = await reserve(tx, "EAN13:2", count);
  const block = Array.from({ length: count }, (_, i) => internalEan13(last - count + 1 + i));
  const taken = new Set((await tx.product.findMany({ where: { barcode: { in: block } }, select: { barcode: true } })).map((p) => p.barcode));
  const out = block.filter((c) => !taken.has(c) && !reserved.has(c));
  for (const c of out) reserved.add(c);
  while (out.length < count) out.push(await nextInternalBarcode(tx, reserved));
  return out;
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
