import "server-only";
import { z } from "zod";
import { msg } from "@/i18n/translator";
import { prisma, type Tx } from "../db";
import { assertCan } from "../access";
import type { CurrentUser } from "../auth/session";
import { NotFoundError, ValidationError } from "../errors";
import { recordAudit } from "./audit";
import { checkId } from "./inventory-common";
import { productDTOInTx, type ProductDTO } from "./inventory-catalog";
import { TX_OPTIONS } from "./inventory-posting";

/**
 * Locking, deactivating and archiving an item are three different things:
 *   - **Locked**: the item's information (names, codes, category, unit, prices, specifications,
 *     images, variants) cannot change until someone with products.unlock unlocks it. Stock still
 *     moves normally and the item stays in every list and picker. For a product with variants
 *     the lock covers the product and its variants.
 *   - **Inactive** (deactivated in the edit form, products.manage): the item cannot be used in new
 *     stock documents or sales, but stays in lists and can still be edited and reactivated. Only
 *     possible once its stock is zero.
 *   - **Archived** (products.archive): retired for good: inactive, hidden from lists and pickers
 *     (shown with the "Archived" filter) and read-only until brought back. Only possible once its
 *     stock is zero, and not while locked.
 * None of them deletes anything: posted documents, the ledger, stocktakes, sales and reports keep
 * showing the item. Every change is audited with who did it, when and why.
 */

const reasonSchema = z.object({ reason: z.preprocess((v) => (typeof v === "string" ? v.trim() || null : (v ?? null)), z.string().max(500).nullable()).optional() });

async function lockRow(tx: Tx, id: string) {
  const rows = await tx.$queryRaw<{ id: string }[]>`SELECT id FROM products WHERE id = ${id} FOR UPDATE`;
  if (!rows.length) throw new NotFoundError();
  return tx.product.findUniqueOrThrow({ where: { id } });
}

/** The product and, for a product with variants, its variants. A variant is handled through its product. */
async function family(tx: Tx, id: string) {
  const p = await lockRow(tx, checkId(id));
  if (p.parentId) throw new ValidationError({ _form: msg("itemLock.errors.variant") }, msg("itemLock.errors.variant"));
  const variants = p.hasVariants ? await tx.product.findMany({ where: { parentId: p.id } }) : [];
  return { p, ids: [p.id, ...variants.map((v) => v.id)] };
}

export async function lockProduct(user: CurrentUser, id: string, raw: unknown, now = new Date()): Promise<ProductDTO> {
  assertCan(user, "products.lock");
  const { reason } = reasonSchema.parse(raw ?? {});
  return prisma.$transaction(async (tx) => {
    const { p, ids } = await family(tx, id);
    if (p.archivedAt) throw new ValidationError({ _form: msg("itemLock.errors.archived", { sku: p.sku }) }, msg("itemLock.errors.archived", { sku: p.sku }));
    if (p.lockedAt) return productDTOInTx(tx, user, p.id); // locked already (a repeated click)
    await tx.product.updateMany({ where: { id: { in: ids } }, data: { lockedAt: now, lockedById: user.id, lockReason: reason ?? null } });
    await recordAudit(tx, {
      entityType: "PRODUCT",
      entityId: p.id,
      module: "products",
      action: "PRODUCT_LOCKED",
      summary: msg("itemLock.audit.locked", { name: user.name, sku: p.sku }),
      reason: reason ?? null,
      changes: { locked: { from: false, to: true }, items: ids.length },
      actorId: user.id,
    });
    return productDTOInTx(tx, user, p.id);
  }, TX_OPTIONS);
}

export async function unlockProduct(user: CurrentUser, id: string, raw: unknown): Promise<ProductDTO> {
  assertCan(user, "products.unlock");
  const { reason } = reasonSchema.parse(raw ?? {});
  return prisma.$transaction(async (tx) => {
    const { p, ids } = await family(tx, id);
    if (!p.lockedAt) return productDTOInTx(tx, user, p.id);
    await tx.product.updateMany({ where: { id: { in: ids } }, data: { lockedAt: null, lockedById: null, lockReason: null } });
    await recordAudit(tx, {
      entityType: "PRODUCT",
      entityId: p.id,
      module: "products",
      action: "PRODUCT_UNLOCKED",
      summary: msg("itemLock.audit.unlocked", { name: user.name, sku: p.sku }),
      reason: reason ?? null,
      changes: { locked: { from: true, to: false }, lockedBy: p.lockedById, lockedAt: p.lockedAt.toISOString(), lockReason: p.lockReason, items: ids.length },
      actorId: user.id,
    });
    return productDTOInTx(tx, user, p.id);
  }, TX_OPTIONS);
}

export async function archiveProduct(user: CurrentUser, id: string, raw: unknown, now = new Date()): Promise<ProductDTO> {
  assertCan(user, "products.archive");
  const { reason } = reasonSchema.parse(raw ?? {});
  return prisma.$transaction(async (tx) => {
    const { p, ids } = await family(tx, id);
    if (p.archivedAt) return productDTOInTx(tx, user, p.id);
    if (p.lockedAt) throw new ValidationError({ _form: msg("itemLock.errors.lockedArchive", { sku: p.sku }) }, msg("itemLock.errors.lockedArchive", { sku: p.sku }));
    const stocked = await tx.stockBalance.findFirst({ where: { productId: { in: ids }, quantity: { not: 0 } }, select: { id: true } });
    if (stocked) throw new ValidationError({ _form: msg("itemLock.errors.archiveWithStock", { sku: p.sku }) }, msg("itemLock.errors.archiveWithStock", { sku: p.sku }));
    await tx.product.updateMany({ where: { id: { in: ids } }, data: { archivedAt: now, archivedById: user.id, isActive: false, updatedById: user.id } });
    await recordAudit(tx, {
      entityType: "PRODUCT",
      entityId: p.id,
      module: "products",
      action: "PRODUCT_ARCHIVED",
      summary: msg("itemLock.audit.archived", { name: user.name, sku: p.sku }),
      reason: reason ?? null,
      changes: { archived: { from: false, to: true }, isActive: { from: p.isActive, to: false }, items: ids.length },
      actorId: user.id,
    });
    return productDTOInTx(tx, user, p.id);
  }, TX_OPTIONS);
}

/** Brings an archived product back. It stays inactive: reactivate it in the edit form when needed. */
export async function unarchiveProduct(user: CurrentUser, id: string, raw: unknown): Promise<ProductDTO> {
  assertCan(user, "products.archive");
  const { reason } = reasonSchema.parse(raw ?? {});
  return prisma.$transaction(async (tx) => {
    const { p, ids } = await family(tx, id);
    if (!p.archivedAt) return productDTOInTx(tx, user, p.id);
    await tx.product.updateMany({ where: { id: { in: ids } }, data: { archivedAt: null, archivedById: null, updatedById: user.id } });
    await recordAudit(tx, {
      entityType: "PRODUCT",
      entityId: p.id,
      module: "products",
      action: "PRODUCT_UNARCHIVED",
      summary: msg("itemLock.audit.unarchived", { name: user.name, sku: p.sku }),
      reason: reason ?? null,
      changes: { archived: { from: true, to: false }, items: ids.length },
      actorId: user.id,
    });
    return productDTOInTx(tx, user, p.id);
  }, TX_OPTIONS);
}
