import "server-only";
import { randomUUID } from "node:crypto";
import { Prisma, type InventoryMovementType, type StockDocument, type StockDocumentLine } from "@prisma/client";
import { msg } from "@/i18n/translator";
import { docPermissions, formatQuantity } from "@/lib/inventory";
import type { Tx } from "../db";
import { assertCan, hasPermission } from "../access";
import type { CurrentUser } from "../auth/session";
import { NotFoundError, ValidationError } from "../errors";
import { recordAudit } from "./audit";
import { D, ZERO, formError, frozenBy, locationLabel, lockProducts, lockWarehouses, productParam } from "./inventory-common";

/**
 * The posting engine: turns a draft stock document into ledger movements and balance changes, and
 * cancels a posted one by writing reversal movements. Everything happens in the caller's
 * transaction, after taking the locks in a fixed order (warehouses shared, then products), so two
 * postings of the same product run one after the other and balances can never be lost or go
 * negative unnoticed. The database refuses negative balances too (stock_balances_guard).
 *
 * Costing is a moving average per product over all warehouses: stock coming in at a cost updates
 * it; stock going out, and transfers, leave it as it is.
 */

type CostRule = "in" | "remove" | "none";

type Effect = {
  lineId: string;
  lineNo: number;
  productId: string;
  warehouseId: string;
  binId: string | null;
  /** Signed: + into the location, - out of it. */
  qty: Prisma.Decimal;
  type: InventoryMovementType;
  unitCost: Prisma.Decimal | null;
  serials: string[];
  reason: string | null;
  reversesId: string | null;
  cost: CostRule;
};

type DocWithLines = StockDocument & { lines: StockDocumentLine[] };

export const TX_OPTIONS = { timeout: 30_000, maxWait: 10_000 };

const IN_TYPES: InventoryMovementType[] = ["OPENING_BALANCE", "GOODS_RECEIPT", "CUSTOMER_RETURN", "ADJUSTMENT_INCREASE"];
const OUT_TYPES: InventoryMovementType[] = ["ISSUE", "SUPPLIER_RETURN", "ADJUSTMENT_DECREASE"];

const bKey = (binId: string | null) => binId ?? "";

/**
 * Movement ids sort in the order the movements were written: the posting time, then the position
 * in the posting (a transfer's "out" before its "in"), then a random part. All movements of one
 * posting share the same timestamp, so the id is what keeps the ledger in posting order.
 */
function movementId(now: Date, seq: number): string {
  return `${now.getTime().toString(36).padStart(9, "0")}-${String(seq).padStart(4, "0")}-${randomUUID().slice(0, 13)}`;
}
const locKey = (p: string, w: string, binId: string | null) => `${p}|${w}|${bKey(binId)}`;
const whKey = (p: string, w: string) => `${p}|${w}`;

/** Locks the document row so a post, an edit and a cancel of it run one after the other. */
export async function lockDocument(tx: Tx, id: string): Promise<DocWithLines> {
  const found = await tx.$queryRaw<{ id: string }[]>`SELECT "id" FROM "stock_documents" WHERE "id" = ${id} FOR UPDATE`;
  if (!found.length) throw new NotFoundError("stock.errors.notFound");
  return tx.stockDocument.findUniqueOrThrow({ where: { id }, include: { lines: { orderBy: { lineNo: "asc" } } } });
}

function docWarehouseIds(doc: Pick<StockDocument, "fromWarehouseId" | "toWarehouseId">): string[] {
  return [doc.fromWarehouseId, doc.toWarehouseId].filter((x): x is string => !!x);
}

/** Refuses to move stock in or out of a warehouse that is being counted (its own stocktake aside). */
async function assertNotFrozen(tx: Tx, doc: Pick<StockDocument, "fromWarehouseId" | "toWarehouseId" | "stocktakeId">) {
  const frozen = await frozenBy(tx, docWarehouseIds(doc), doc.stocktakeId);
  if (frozen) throw formError("stock.errors.frozen", { code: frozen.warehouse.code, number: frozen.number });
}

function effectsForPosting(doc: DocWithLines): Effect[] {
  const out: Effect[] = [];
  for (const l of doc.lines) {
    const base = { lineId: l.id, lineNo: l.lineNo, productId: l.productId, serials: l.serials, reason: l.reason, reversesId: null };
    const qty = D(l.quantity);
    const into = (type: InventoryMovementType, cost: CostRule, binId: string | null, unitCost: Prisma.Decimal | null) =>
      out.push({ ...base, warehouseId: doc.toWarehouseId!, binId, qty, type, unitCost, cost });
    const outOf = (type: InventoryMovementType, warehouseId: string, binId: string | null) =>
      out.push({ ...base, warehouseId, binId, qty: qty.negated(), type, unitCost: null, cost: "none" });
    const lineCost = l.unitCost ? D(l.unitCost) : null;
    switch (doc.type) {
      case "OPENING":
        into("OPENING_BALANCE", "in", l.toBinId, lineCost);
        break;
      case "RECEIPT":
        into("GOODS_RECEIPT", "in", l.toBinId, lineCost);
        break;
      case "ISSUE":
        outOf("ISSUE", doc.fromWarehouseId!, l.fromBinId);
        break;
      case "TRANSFER":
        outOf("TRANSFER_OUT", doc.fromWarehouseId!, l.fromBinId);
        out.push({ ...base, warehouseId: doc.toWarehouseId!, binId: l.toBinId, qty, type: "TRANSFER_IN", unitCost: null, cost: "none" });
        break;
      case "RETURN":
        if (doc.returnKind === "SUPPLIER") outOf("SUPPLIER_RETURN", doc.fromWarehouseId!, l.fromBinId);
        else into("CUSTOMER_RETURN", "in", l.toBinId, lineCost);
        break;
      case "ADJUSTMENT":
        if (l.direction === "DECREASE") outOf("ADJUSTMENT_DECREASE", doc.toWarehouseId!, l.fromBinId);
        else into("ADJUSTMENT_INCREASE", "in", l.toBinId, lineCost);
        break;
    }
  }
  return out;
}

/**
 * Applies effects in order: validates availability and serial locations against current
 * balances (under the product locks), then writes balances, movements, serial locations and
 * average costs. Throws a ValidationError (nothing written) when stock or serials do not allow it.
 */
async function applyEffects(tx: Tx, user: CurrentUser, doc: StockDocument, effects: Effect[], now: Date): Promise<number> {
  const productIds = [...new Set(effects.map((e) => e.productId))];
  await lockProducts(tx, productIds);

  const warehouseIds = [...new Set(effects.map((e) => e.warehouseId))];
  const binIds = [...new Set(effects.map((e) => e.binId).filter((x): x is string => !!x))];
  const [products, warehouses, bins, balances, totals] = await Promise.all([
    tx.product.findMany({ where: { id: { in: productIds } }, include: { unit: { select: { allowsFraction: true } } } }),
    tx.warehouse.findMany({ where: { id: { in: warehouseIds } }, select: { id: true, code: true, allowNegative: true } }),
    binIds.length ? tx.warehouseBin.findMany({ where: { id: { in: binIds } }, select: { id: true, code: true } }) : [],
    tx.stockBalance.findMany({ where: { productId: { in: productIds }, warehouseId: { in: warehouseIds } }, select: { productId: true, warehouseId: true, binKey: true, quantity: true } }),
    tx.stockBalance.groupBy({ by: ["productId"], where: { productId: { in: productIds } }, _sum: { quantity: true } }),
  ]);
  const product = new Map(products.map((p) => [p.id, p]));
  const warehouse = new Map(warehouses.map((w) => [w.id, w]));
  const bin = new Map(bins.map((b) => [b.id, b]));
  const atLoc = new Map<string, Prisma.Decimal>();
  const atWh = new Map<string, Prisma.Decimal>();
  for (const b of balances) {
    atLoc.set(`${b.productId}|${b.warehouseId}|${b.binKey}`, D(b.quantity));
    atWh.set(whKey(b.productId, b.warehouseId), (atWh.get(whKey(b.productId, b.warehouseId)) ?? ZERO).plus(b.quantity));
  }
  const total = new Map(totals.map((t) => [t.productId, D(t._sum.quantity ?? 0)]));
  const avg = new Map(products.map((p) => [p.id, D(p.averageCost)]));
  const avgChanged = new Set<string>();

  const fieldErrors: Record<string, string> = {};
  let firstError: string | null = null;
  const fail = (lineNo: number, field: string, m: string) => {
    fieldErrors[`lines.${lineNo - 1}.${field}`] ??= m;
    firstError ??= m;
  };
  const where = (e: Effect) => locationLabel(warehouse.get(e.warehouseId)!, e.binId ? bin.get(e.binId) : null);

  // Serial locations as they will be after each effect (mandatory and optional serials).
  const located = (productId: string) => {
    const p = product.get(productId)!;
    return p.trackSerials || p.serialsOptional;
  };
  const serialLookups = effects.filter((e) => e.serials.length && located(e.productId)).map((e) => ({ productId: e.productId, serial: { in: e.serials } }));
  const serialRows = serialLookups.length
    ? await tx.productSerial.findMany({ where: { OR: serialLookups }, select: { id: true, productId: true, serial: true, warehouseId: true, binId: true } })
    : [];
  const serialAt = new Map<string, { warehouseId: string | null; binId: string | null }>(serialRows.map((s) => [`${s.productId}|${s.serial}`, { warehouseId: s.warehouseId, binId: s.binId }]));
  const serialKnown = new Set(serialRows.map((s) => `${s.productId}|${s.serial}`));
  // Optional serials: how many recorded serials each touched location holds, so that a location
  // never ends up with more recorded serials than units (stock leaving without naming its serials
  // would otherwise leave serials "in stock" that are not there).
  const optionalIds = productIds.filter((id) => product.get(id)!.serialsOptional);
  const serialCount = new Map<string, number>();
  if (optionalIds.length) {
    const counts = await tx.productSerial.groupBy({ by: ["productId", "warehouseId", "binId"], where: { productId: { in: optionalIds }, warehouseId: { in: warehouseIds } }, _count: { _all: true } });
    for (const c of counts) serialCount.set(locKey(c.productId, c.warehouseId!, c.binId), c._count._all);
  }
  const optionalTouched = new Map<string, Effect>();

  const planned: (Effect & { id: string; balanceAfter: Prisma.Decimal; unitCostUsed: Prisma.Decimal })[] = [];
  for (const e of effects) {
    const p = product.get(e.productId)!;
    const w = warehouse.get(e.warehouseId)!;
    const lk = locKey(e.productId, e.warehouseId, e.binId);
    const before = atLoc.get(lk) ?? ZERO;
    const after = before.plus(e.qty);
    const whAfter = (atWh.get(whKey(e.productId, e.warehouseId)) ?? ZERO).plus(e.qty);

    if (!p.unit.allowsFraction && !e.qty.isInteger()) fail(e.lineNo, "quantity", msg("stock.errors.wholeQuantity"));
    if (e.qty.isNegative() && after.isNegative() && (p.trackSerials || !w.allowNegative)) {
      fail(
        e.lineNo,
        "quantity",
        msg("stock.errors.insufficient", { ...productParam("product", p), location: where(e), available: formatQuantity(before.toNumber(), "en"), needed: formatQuantity(e.qty.abs().toNumber(), "en") }),
      );
    }

    if (p.trackSerials || p.serialsOptional) {
      const count = e.qty.abs();
      if (p.trackSerials && (!count.isInteger() || !count.equals(e.serials.length))) fail(e.lineNo, "serials", msg("stock.errors.serialCount", { count: count.toNumber(), given: e.serials.length }));
      if (p.serialsOptional && e.serials.length && (!count.isInteger() || count.lessThan(e.serials.length))) {
        fail(e.lineNo, "serials", msg("serialModes.tooManySerials", { count: count.toNumber(), given: e.serials.length }));
      }
      const wrong: string[] = [];
      for (const s of e.serials) {
        const k = `${e.productId}|${s}`;
        const cur = serialAt.get(k) ?? { warehouseId: null, binId: null };
        if (e.qty.isNegative()) {
          if (cur.warehouseId !== e.warehouseId || (cur.binId ?? null) !== e.binId) wrong.push(s);
          else serialAt.set(k, { warehouseId: null, binId: null });
        } else {
          if (cur.warehouseId) wrong.push(s);
          else serialAt.set(k, { warehouseId: e.warehouseId, binId: e.binId });
        }
      }
      if (wrong.length) {
        const list = wrong.slice(0, 5).join(", ");
        fail(e.lineNo, "serials", e.qty.isNegative() ? msg("stock.errors.serialNotHere", { list, location: where(e) }) : msg("stock.errors.serialInStock", { list }));
      }
      if (p.serialsOptional) {
        const moved = e.serials.length - wrong.length;
        serialCount.set(lk, (serialCount.get(lk) ?? 0) + (e.qty.isNegative() ? -moved : moved));
        optionalTouched.set(lk, e);
      }
    } else if (e.serials.length) {
      fail(e.lineNo, "serials", msg("stock.errors.noSerials"));
    }

    // Moving average cost.
    const t = total.get(e.productId) ?? ZERO;
    const a = avg.get(e.productId) ?? ZERO;
    let unitCostUsed = e.unitCost ?? a;
    if (e.cost === "in") {
      if (!e.unitCost && (e.type === "OPENING_BALANCE" || e.type === "GOODS_RECEIPT")) {
        if (p.purchaseCost) unitCostUsed = D(p.purchaseCost);
        else fail(e.lineNo, "unitCost", msg("stock.errors.costRequired", productParam("product", p)));
      }
      const base = Prisma.Decimal.max(t, 0);
      const newQty = base.plus(e.qty);
      const next = newQty.greaterThan(0) ? base.times(a).plus(e.qty.times(unitCostUsed)).dividedBy(newQty) : unitCostUsed;
      avg.set(e.productId, next.toDecimalPlaces(4));
      avgChanged.add(e.productId);
    } else if (e.cost === "remove") {
      const removed = e.qty.abs();
      const rest = t.minus(removed);
      if (rest.greaterThan(0)) {
        avg.set(e.productId, Prisma.Decimal.max(t.times(a).minus(removed.times(unitCostUsed)).dividedBy(rest), 0).toDecimalPlaces(4));
        avgChanged.add(e.productId);
      }
    }

    atLoc.set(lk, after);
    atWh.set(whKey(e.productId, e.warehouseId), whAfter);
    total.set(e.productId, t.plus(e.qty));
    planned.push({ ...e, id: movementId(now, planned.length), balanceAfter: whAfter, unitCostUsed: unitCostUsed.toDecimalPlaces(4) });
  }
  for (const [lk, e] of optionalTouched) {
    const held = serialCount.get(lk) ?? 0;
    const units = atLoc.get(lk) ?? ZERO;
    if (held > 0 && units.lessThan(held)) {
      fail(e.lineNo, "serials", msg("serialModes.nameSerials", { ...productParam("product", product.get(e.productId)!), location: where(e), count: held, units: formatQuantity(units.toNumber(), "en") }));
    }
  }
  if (firstError) throw new ValidationError({ _form: firstError, ...fieldErrors }, firstError);

  for (const e of planned) {
    // Update the location's row; create it the first time stock arrives there. (Not an upsert:
    // PostgreSQL checks the proposed new row, with the bare negative quantity, before it notices
    // the conflict, so the no-negative guard would refuse every outgoing upsert.)
    const updated = await tx.$executeRaw`
      UPDATE "stock_balances" SET "quantity" = "quantity" + ${e.qty.toString()}::numeric, "updatedAt" = ${now}
      WHERE "productId" = ${e.productId} AND "warehouseId" = ${e.warehouseId} AND "binKey" = ${bKey(e.binId)}`;
    if (!updated) {
      await tx.$executeRaw`
        INSERT INTO "stock_balances" ("id", "productId", "warehouseId", "binId", "binKey", "quantity", "updatedAt")
        VALUES (${randomUUID()}, ${e.productId}, ${e.warehouseId}, ${e.binId}, ${bKey(e.binId)}, ${e.qty.toString()}::numeric, ${now})`;
    }
  }
  await tx.inventoryMovement.createMany({
    data: planned.map((e) => ({
      id: e.id,
      documentId: doc.id,
      lineId: e.lineId,
      type: e.type,
      productId: e.productId,
      warehouseId: e.warehouseId,
      binId: e.binId,
      quantity: e.qty,
      fromWarehouseId: doc.fromWarehouseId,
      toWarehouseId: doc.toWarehouseId,
      unitCost: e.unitCostUsed,
      serials: e.serials,
      reason: e.reason,
      reversesId: e.reversesId,
      balanceAfter: e.balanceAfter,
      documentDate: doc.documentDate,
      createdById: user.id,
      createdAt: now,
    })),
  });

  // Serial locations: the last movement that touched each serial decides where it is.
  const lastMove = new Map<string, string>();
  for (const e of planned) if (located(e.productId)) for (const s of e.serials) lastMove.set(`${e.productId}|${s}`, e.id);
  const fresh: Prisma.ProductSerialCreateManyInput[] = [];
  for (const [k, movementId] of lastMove) {
    const [productId, serial] = k.split("|") as [string, string];
    const at = serialAt.get(k)!;
    if (serialKnown.has(k)) {
      await tx.productSerial.update({ where: { productId_serial: { productId, serial } }, data: { warehouseId: at.warehouseId, binId: at.binId, lastMovementId: movementId } });
    } else {
      fresh.push({ productId, serial, warehouseId: at.warehouseId, binId: at.binId, lastMovementId: movementId });
    }
  }
  if (fresh.length) await tx.productSerial.createMany({ data: fresh });

  for (const id of avgChanged) await tx.product.update({ where: { id }, data: { averageCost: avg.get(id)! } });
  return planned.length;
}

/** Re-checks a draft right before posting: active products, warehouses and bins. */
async function assertPostable(tx: Tx, doc: DocWithLines) {
  if (!doc.lines.length) throw formError("stock.errors.noLines");
  const whIds = docWarehouseIds(doc);
  const [warehouses, products, bins] = await Promise.all([
    tx.warehouse.findMany({ where: { id: { in: whIds } }, select: { id: true, code: true, isActive: true } }),
    tx.product.findMany({ where: { id: { in: doc.lines.map((l) => l.productId) } }, select: { id: true, sku: true, nameEn: true, nameAr: true, isActive: true, hasVariants: true } }),
    tx.warehouseBin.findMany({ where: { id: { in: doc.lines.flatMap((l) => [l.fromBinId, l.toBinId]).filter((x): x is string => !!x) } }, select: { id: true, code: true, isActive: true, warehouseId: true } }),
  ]);
  const inactive = warehouses.find((w) => !w.isActive);
  if (inactive) throw formError("stock.errors.warehouseInactive", { code: inactive.code });
  const off = products.find((p) => !p.isActive);
  if (off) throw formError("stock.errors.productInactive", productParam("product", off));
  const parent = products.find((p) => p.hasVariants);
  if (parent) throw formError("variants.errors.pickVariant", productParam("product", parent));
  const offBin = bins.find((b) => !b.isActive);
  if (offBin) throw formError("stock.errors.binInactive", { code: offBin.code });
}

function auditType(doc: Pick<StockDocument, "type" | "returnKind">) {
  return doc.type === "RETURN" ? `@enums.stockDocType.RETURN_${doc.returnKind ?? "CUSTOMER"}` : `@enums.stockDocType.${doc.type}`;
}

export type PostOptions = { now?: Date; /** set by stocktake approval, which checks its own permission */ asStocktakeApproval?: boolean };

/**
 * Posts a draft inside the caller's transaction. Posting an already posted document is a no-op
 * (a repeated click or retry), so the stock moves exactly once.
 */
export async function postInTx(tx: Tx, user: CurrentUser, id: string, opts: PostOptions = {}): Promise<{ posted: boolean }> {
  const now = opts.now ?? new Date();
  const doc = await lockDocument(tx, id);
  if (doc.status === "POSTED") return { posted: false };
  if (doc.status === "CANCELLED") throw formError("stock.errors.cancelled");
  if (!opts.asStocktakeApproval) assertCan(user, docPermissions(doc.type, doc.returnKind).post);
  await lockWarehouses(tx, docWarehouseIds(doc), "shared");
  await assertNotFrozen(tx, doc);
  await assertPostable(tx, doc);
  const count = await applyEffects(tx, user, doc, effectsForPosting(doc), now);
  await tx.stockDocument.update({ where: { id: doc.id }, data: { status: "POSTED", postedAt: now, postedById: user.id, version: { increment: 1 } } });
  await recordAudit(tx, {
    entityType: "INVENTORY",
    entityId: doc.id,
    action: "STOCK_DOC_POSTED",
    summary: msg("audit.stockDocPosted", { name: user.name, number: doc.number, type: auditType(doc) }),
    changes: { number: doc.number, lines: doc.lines.length, movements: count },
    actorId: user.id,
  });
  return { posted: true };
}

/**
 * Cancels a document inside the caller's transaction. A draft is simply closed; a posted document
 * gets one REVERSAL movement per original movement (newest first), which needs the approval
 * permission and a reason. Nothing is deleted. Cancelling twice is a no-op.
 */
export async function cancelInTx(tx: Tx, user: CurrentUser, id: string, reason: string | null, now = new Date()): Promise<{ cancelled: boolean }> {
  const doc = await lockDocument(tx, id);
  if (doc.status === "CANCELLED") return { cancelled: false };
  const perms = docPermissions(doc.type, doc.returnKind);

  if (doc.status === "DRAFT") {
    if (!hasPermission(user, perms.prepare) && !hasPermission(user, "inventory.approve")) assertCan(user, perms.prepare);
    await tx.stockDocument.update({ where: { id: doc.id }, data: { status: "CANCELLED", cancelledAt: now, cancelledById: user.id, cancelReason: reason, version: { increment: 1 } } });
    await recordAudit(tx, {
      entityType: "INVENTORY",
      entityId: doc.id,
      action: "STOCK_DOC_CANCELLED",
      summary: msg("audit.stockDocDraftCancelled", { name: user.name, number: doc.number, type: auditType(doc) }),
      changes: { reason },
      actorId: user.id,
    });
    return { cancelled: true };
  }

  assertCan(user, "inventory.approve");
  if (!reason) throw new ValidationError({ reason: msg("stock.errors.cancelReason") }, msg("stock.errors.cancelReason"));
  await lockWarehouses(tx, docWarehouseIds(doc), "shared");
  await assertNotFrozen(tx, { ...doc, stocktakeId: null });

  const lineNo = new Map(doc.lines.map((l) => [l.id, l.lineNo]));
  const originals = await tx.inventoryMovement.findMany({ where: { documentId: doc.id, reversesId: null, type: { not: "REVERSAL" } } });
  // The original order was by line, and for a transfer: out, then in. Undo it backwards.
  originals.sort((a, b) => (lineNo.get(b.lineId)! - lineNo.get(a.lineId)!) || (b.quantity.isNegative() ? 0 : 1) - (a.quantity.isNegative() ? 0 : 1));
  const effects: Effect[] = originals.map((m) => ({
    lineId: m.lineId,
    lineNo: lineNo.get(m.lineId)!,
    productId: m.productId,
    warehouseId: m.warehouseId,
    binId: m.binId,
    qty: D(m.quantity).negated(),
    type: "REVERSAL",
    unitCost: D(m.unitCost),
    serials: m.serials,
    reason,
    reversesId: m.id,
    cost: IN_TYPES.includes(m.type) ? "remove" : OUT_TYPES.includes(m.type) ? "in" : "none",
  }));
  try {
    await applyEffects(tx, user, doc, effects, now);
  } catch (e) {
    // Say why in the reader's language: the general refusal, with the particular shortage below it.
    if (e instanceof ValidationError) throw new ValidationError({ ...e.rawFieldErrors, _form: e.rawFieldErrors._form ?? e.raw }, msg("stock.errors.cannotReverse"));
    throw e;
  }
  await tx.stockDocument.update({ where: { id: doc.id }, data: { status: "CANCELLED", cancelledAt: now, cancelledById: user.id, cancelReason: reason, version: { increment: 1 } } });
  await recordAudit(tx, {
    entityType: "INVENTORY",
    entityId: doc.id,
    action: "STOCK_DOC_REVERSED",
    summary: msg("audit.stockDocReversed", { name: user.name, number: doc.number, type: auditType(doc), reason }),
    changes: { reason, movements: effects.length },
    actorId: user.id,
  });
  return { cancelled: true };
}

/** A database refusal of a negative balance that slipped past the checks above (should not happen). */
export function mapStockDbError(e: unknown): unknown {
  const text = e instanceof Error ? e.message : "";
  if (text.includes("negative stock is not allowed")) return formError("stock.errors.negativeBlocked");
  if (text.includes("cannot be changed") && text.includes("stock_documents")) return formError("stock.errors.notDraft");
  return e;
}
