import "server-only";
import { Prisma, type StockDocStatus, type StockDocType, type StockReturnKind } from "@prisma/client";
import { msg } from "@/i18n/translator";
import { DOC_PREFIX, STOCK_DOC_STATUSES, STOCK_DOC_TYPES, cancelDocSchema, docPermissions, docWarehouseSides, formatDocNumber, lineTakesCost, stockDocSchema, type StockDocInput } from "@/lib/inventory";
import { isValidDateString } from "@/lib/time";
import { prisma, type Tx } from "../db";
import { assertCan, hasPermission } from "../access";
import type { CurrentUser } from "../auth/session";
import { NotFoundError, StaleRecordError, ValidationError } from "../errors";
import { recordAudit } from "./audit";
import { isUniqueViolation } from "./scheduling";
import { canSeeCosts, checkId, dbDate, documentScope, formError, keyOf, nextSequence, num, numOrNull, pageOf, parseInput, today, warehouseScope } from "./inventory-common";
import { TX_OPTIONS, cancelInTx, lockDocument, mapStockDbError, postInTx } from "./inventory-posting";

/**
 * Stock documents: goods receipts, issues, transfers, customer / supplier returns, adjustments and
 * opening balances. A document is numbered when its draft is created, can be edited while it is a
 * draft, and is then posted (writes the ledger) or cancelled. A posted document never changes;
 * cancelling it writes reversal movements.
 */

type NormalLine = {
  lineNo: number;
  productId: string;
  quantity: number;
  unitCost: number | null;
  fromBinId: string | null;
  toBinId: string | null;
  direction: "INCREASE" | "DECREASE" | null;
  serials: string[];
  reason: string | null;
};

/** Checks a document against the catalogue and warehouses and returns its lines as stored. */
async function validateDraft(
  tx: Tx,
  user: CurrentUser,
  input: StockDocInput,
  now: Date,
  previous: { lineNo: number; productId: string; unitCost: Prisma.Decimal | null }[] = [],
): Promise<NormalLine[]> {
  const errors: Record<string, string> = {};
  // Someone who may not see costs never received them, so their edit keeps the costs already on
  // the draft (same line, same product) instead of clearing them.
  const hiddenCost = new Map(canSeeCosts(user) ? [] : previous.filter((l) => l.unitCost).map((l) => [`${l.lineNo}|${l.productId}`, l.unitCost!.toNumber()]));
  const sides = docWarehouseSides(input.type, input.returnKind);
  const fromId = sides.from ? input.fromWarehouseId : null;
  const toId = sides.to ? input.toWarehouseId : null;
  if (input.documentDate > today(user, now)) errors.documentDate = msg("stock.errors.futureDate");

  const whIds = [fromId, toId].filter((x): x is string => !!x);
  const warehouses = await tx.warehouse.findMany({ where: { AND: [{ id: { in: whIds } }, warehouseScope(user)] }, select: { id: true, isActive: true } });
  for (const [field, id] of [["fromWarehouseId", fromId], ["toWarehouseId", toId]] as const) {
    if (!id) continue;
    const w = warehouses.find((x) => x.id === id);
    if (!w || !w.isActive) errors[field] = msg("stock.errors.warehouse");
  }

  const productIds = [...new Set(input.lines.map((l) => l.productId))];
  const binIds = [...new Set(input.lines.flatMap((l) => [l.fromBinId, l.toBinId]).filter((x): x is string => !!x))];
  const [products, bins] = await Promise.all([
    tx.product.findMany({ where: { id: { in: productIds } }, include: { unit: true } }),
    binIds.length ? tx.warehouseBin.findMany({ where: { id: { in: binIds } } }) : [],
  ]);
  const product = new Map(products.map((p) => [p.id, p]));
  const bin = new Map(bins.map((b) => [b.id, b]));
  const seenSerials = new Map<string, number>();

  const lines = input.lines.map((l, i): NormalLine => {
    const at = (f: string, m: string) => (errors[`lines.${i}.${f}`] ??= m);
    const p = product.get(l.productId);
    if (!p || !p.isActive) at("productId", msg("stock.errors.product"));
    else if (p.hasVariants) at("productId", msg("variants.errors.pickVariant", { product: `${p.sku} ${p.nameEn}`, productAr: `${p.sku} ${p.nameAr}` }));
    // Adjustments name one warehouse; the bin goes on the side the stock moves.
    let fromBinId = sides.from ? l.fromBinId : null;
    let toBinId = sides.to ? l.toBinId : null;
    if (input.type === "ADJUSTMENT") {
      const b = l.toBinId ?? l.fromBinId;
      fromBinId = l.direction === "DECREASE" ? b : null;
      toBinId = l.direction === "DECREASE" ? null : b;
    }
    const checkBin = (id: string | null, warehouseId: string | null, field: string) => {
      if (!id) return;
      const b = bin.get(id);
      if (!b || b.warehouseId !== warehouseId || !b.isActive) at(field, msg("stock.errors.bin"));
    };
    const adjWh = input.type === "ADJUSTMENT" ? toId : null;
    checkBin(fromBinId, adjWh ?? fromId, "fromBinId");
    checkBin(toBinId, adjWh ?? toId, "toBinId");
    if (p) {
      if (!p.unit.allowsFraction && !Number.isInteger(l.quantity)) at("quantity", msg("stock.errors.wholeUnits", { unit: p.unit.nameEn, unitAr: p.unit.nameAr }));
      if (p.trackSerials || p.serialsOptional) {
        if (p.trackSerials && (!Number.isInteger(l.quantity) || l.serials.length !== l.quantity)) at("serials", msg("stock.errors.serialCount", { count: l.quantity, given: l.serials.length }));
        if (p.serialsOptional && l.serials.length && (!Number.isInteger(l.quantity) || l.serials.length > l.quantity)) at("serials", msg("serialModes.tooManySerials", { count: l.quantity, given: l.serials.length }));
        for (const s of l.serials) {
          const k = `${p.id}|${s}`;
          if (seenSerials.has(k)) at("serials", msg("stock.errors.serialTwice", { list: s }));
          seenSerials.set(k, i);
        }
      } else if (l.serials.length) at("serials", msg("stock.errors.noSerials"));
    }
    const takesCost = lineTakesCost(input.type, input.returnKind, l.direction);
    const unitCost = l.unitCost ?? hiddenCost.get(`${i + 1}|${l.productId}`) ?? null;
    if (takesCost && unitCost === null && (input.type === "OPENING" || input.type === "RECEIPT") && p && !p.purchaseCost) {
      at("unitCost", msg("stock.errors.costRequired", { product: `${p.sku} ${p.nameEn}`, productAr: `${p.sku} ${p.nameAr}` }));
    }
    return {
      lineNo: i + 1,
      productId: l.productId,
      quantity: l.quantity,
      unitCost: takesCost ? unitCost : null,
      fromBinId,
      toBinId,
      direction: input.type === "ADJUSTMENT" ? l.direction : null,
      serials: p?.trackSerials || p?.serialsOptional ? l.serials : [],
      reason: l.reason,
    };
  });
  if (Object.keys(errors).length) throw new ValidationError(errors);
  return lines;
}

function headerData(input: StockDocInput) {
  const sides = docWarehouseSides(input.type, input.returnKind);
  return {
    type: input.type,
    returnKind: input.type === "RETURN" ? input.returnKind : null,
    fromWarehouseId: sides.from ? input.fromWarehouseId : null,
    toWarehouseId: sides.to ? input.toWarehouseId : null,
    documentDate: dbDate(input.documentDate),
    reference: input.reference,
    counterparty: input.counterparty,
    note: input.note,
  };
}

/** Creates a draft (and posts it at once when `post` is set), in one transaction. */
export async function createDocument(user: CurrentUser, raw: unknown, opts: { post?: boolean; now?: Date } = {}): Promise<{ id: string; number: string }> {
  const input = parseInput(stockDocSchema, raw);
  const perms = docPermissions(input.type, input.returnKind);
  assertCan(user, perms.prepare);
  if (opts.post) assertCan(user, perms.post);
  const now = opts.now ?? new Date();

  // A repeated submit (double click, retry after a dropped connection) returns the first one.
  if (input.clientRequestId) {
    const existing = await prisma.stockDocument.findUnique({ where: { clientRequestId: input.clientRequestId }, select: { id: true, number: true, createdById: true } });
    if (existing) {
      if (existing.createdById !== user.id) throw formError("stock.errors.duplicateRequest");
      return { id: existing.id, number: existing.number };
    }
  }
  try {
    return await prisma.$transaction(async (tx) => {
      const lines = await validateDraft(tx, user, input, now);
      const year = Number(input.documentDate.slice(0, 4));
      const prefix = DOC_PREFIX[input.type];
      const number = formatDocNumber(prefix, year, await nextSequence(tx, `${prefix}-${year}`));
      const doc = await tx.stockDocument.create({
        data: { ...headerData(input), number, clientRequestId: input.clientRequestId ?? null, createdById: user.id, createdAt: now, lines: { create: lines } },
      });
      await recordAudit(tx, {
        entityType: "INVENTORY",
        entityId: doc.id,
        action: "STOCK_DOC_CREATED",
        summary: msg("audit.stockDocCreated", { name: user.name, number, type: auditTypeOf(input.type, input.returnKind) }),
        changes: { number, lines: lines.length },
        actorId: user.id,
      });
      if (opts.post) await postInTx(tx, user, doc.id, { now });
      return { id: doc.id, number };
    }, TX_OPTIONS);
  } catch (e) {
    if (input.clientRequestId && isUniqueViolation(e, "clientRequestId")) {
      const existing = await prisma.stockDocument.findUnique({ where: { clientRequestId: input.clientRequestId }, select: { id: true, number: true, createdById: true } });
      if (existing && existing.createdById === user.id) return { id: existing.id, number: existing.number };
    }
    throw mapStockDbError(e);
  }
}

export async function updateDocument(user: CurrentUser, id: string, raw: unknown, opts: { post?: boolean; now?: Date } = {}): Promise<{ id: string; number: string }> {
  const input = parseInput(stockDocSchema, raw);
  const now = opts.now ?? new Date();
  try {
    return await prisma.$transaction(async (tx) => {
      const doc = await lockDocument(tx, checkId(id));
      if (!(await tx.stockDocument.findFirst({ where: { AND: [{ id: doc.id }, documentScope(user)] }, select: { id: true } }))) throw new NotFoundError("stock.errors.notFound");
      if (doc.status !== "DRAFT") throw formError("stock.errors.notDraft");
      if (doc.type !== input.type || (doc.type === "RETURN" && doc.returnKind !== input.returnKind)) throw formError("stock.errors.typeFixed");
      if (doc.stocktakeId) throw formError("stock.errors.fromStocktake");
      if (input.version !== undefined && input.version !== doc.version) throw new StaleRecordError();
      const perms = docPermissions(doc.type, doc.returnKind);
      assertCan(user, perms.prepare);
      if (opts.post) assertCan(user, perms.post);
      const lines = await validateDraft(tx, user, input, now, doc.lines);
      // The type and return kind stay as they are (checked above).
      const { fromWarehouseId, toWarehouseId, documentDate, reference, counterparty, note } = headerData(input);
      const header = { fromWarehouseId, toWarehouseId, documentDate, reference, counterparty, note };
      await tx.stockDocumentLine.deleteMany({ where: { documentId: doc.id } });
      await tx.stockDocument.update({ where: { id: doc.id }, data: { ...header, version: { increment: 1 }, lines: { create: lines } } });
      await recordAudit(tx, {
        entityType: "INVENTORY",
        entityId: doc.id,
        action: "STOCK_DOC_UPDATED",
        summary: msg("audit.stockDocUpdated", { name: user.name, number: doc.number, type: auditTypeOf(doc.type, doc.returnKind) }),
        changes: { lines: lines.length },
        actorId: user.id,
      });
      if (opts.post) await postInTx(tx, user, doc.id, { now });
      return { id: doc.id, number: doc.number };
    }, TX_OPTIONS);
  } catch (e) {
    throw mapStockDbError(e);
  }
}

export async function postDocument(user: CurrentUser, id: string, now = new Date()) {
  await assertVisible(user, id);
  try {
    await prisma.$transaction((tx) => postInTx(tx, user, checkId(id), { now }), TX_OPTIONS);
  } catch (e) {
    throw mapStockDbError(e);
  }
  return getDocument(user, id);
}

export async function cancelDocument(user: CurrentUser, id: string, raw: unknown, now = new Date()) {
  const { reason, version } = parseInput(cancelDocSchema, raw);
  await assertVisible(user, id);
  try {
    await prisma.$transaction(async (tx) => {
      if (version !== undefined) {
        const current = await tx.stockDocument.findUnique({ where: { id }, select: { version: true, status: true } });
        if (current && current.status !== "CANCELLED" && current.version !== version) throw new StaleRecordError();
      }
      await cancelInTx(tx, user, checkId(id), reason, now);
    }, TX_OPTIONS);
  } catch (e) {
    throw mapStockDbError(e);
  }
  return getDocument(user, id);
}

async function assertVisible(user: CurrentUser, id: string) {
  const doc = await prisma.stockDocument.findFirst({ where: { AND: [{ id: checkId(id) }, documentScope(user)] }, select: { id: true } });
  if (!doc) throw new NotFoundError("stock.errors.notFound");
}

function auditTypeOf(type: StockDocType, returnKind: StockReturnKind | null) {
  return type === "RETURN" ? `@enums.stockDocType.RETURN_${returnKind ?? "CUSTOMER"}` : `@enums.stockDocType.${type}`;
}

// ---- Reading ---------------------------------------------------------------------------------

const whSelect = { id: true, code: true, nameEn: true, nameAr: true, kind: true } satisfies Prisma.WarehouseSelect;
const userSelect = { id: true, name: true } satisfies Prisma.UserSelect;

export type DocFilters = { type?: string; status?: string; warehouseId?: string; q?: string; from?: string; to?: string; page?: number };

export async function listDocuments(user: CurrentUser, f: DocFilters) {
  assertCan(user, "inventory.view");
  const pageSize = 25;
  const { page, skip, take } = pageOf(f.page, pageSize);
  const and: Prisma.StockDocumentWhereInput[] = [documentScope(user)];
  if (f.type && (STOCK_DOC_TYPES as string[]).includes(f.type)) and.push({ type: f.type as StockDocType });
  if (f.status && (STOCK_DOC_STATUSES as string[]).includes(f.status)) and.push({ status: f.status as StockDocStatus });
  if (f.warehouseId) and.push({ OR: [{ fromWarehouseId: f.warehouseId }, { toWarehouseId: f.warehouseId }] });
  if (f.from && isValidDateString(f.from)) and.push({ documentDate: { gte: dbDate(f.from) } });
  if (f.to && isValidDateString(f.to)) and.push({ documentDate: { lte: dbDate(f.to) } });
  const q = f.q?.trim().slice(0, 100);
  if (q) and.push({ OR: [{ number: { contains: q.toUpperCase() } }, { reference: { contains: q, mode: "insensitive" } }, { counterparty: { contains: q, mode: "insensitive" } }] });
  const where: Prisma.StockDocumentWhereInput = { AND: and };
  const [total, rows] = await Promise.all([
    prisma.stockDocument.count({ where }),
    prisma.stockDocument.findMany({
      where,
      include: { fromWarehouse: { select: whSelect }, toWarehouse: { select: whSelect }, createdBy: { select: userSelect }, _count: { select: { lines: true } } },
      orderBy: [{ createdAt: "desc" }, { number: "desc" }],
      skip,
      take,
    }),
  ]);
  return {
    total,
    page,
    pageSize,
    pageCount: Math.max(1, Math.ceil(total / pageSize)),
    rows: rows.map((d) => ({
      id: d.id,
      number: d.number,
      type: d.type,
      returnKind: d.returnKind,
      status: d.status,
      documentDate: keyOf(d.documentDate),
      from: d.fromWarehouse,
      to: d.toWarehouse,
      reference: d.reference,
      counterparty: d.counterparty,
      lineCount: d._count.lines,
      createdBy: d.createdBy,
      createdAt: d.createdAt.toISOString(),
    })),
  };
}
export type DocListRow = Awaited<ReturnType<typeof listDocuments>>["rows"][number];

export async function getDocument(user: CurrentUser, id: string) {
  assertCan(user, "inventory.view");
  const d = await prisma.stockDocument.findFirst({
    where: { AND: [{ id: checkId(id) }, documentScope(user)] },
    include: {
      fromWarehouse: { select: { ...whSelect, bins: { where: { isActive: true }, select: { id: true, code: true }, orderBy: { code: "asc" } } } },
      toWarehouse: { select: { ...whSelect, bins: { where: { isActive: true }, select: { id: true, code: true }, orderBy: { code: "asc" } } } },
      createdBy: { select: userSelect },
      postedBy: { select: userSelect },
      cancelledBy: { select: userSelect },
      stocktake: { select: { id: true, number: true } },
      lines: {
        orderBy: { lineNo: "asc" },
        include: {
          product: { select: { id: true, sku: true, nameEn: true, nameAr: true, trackSerials: true, serialsOptional: true, unit: { select: { code: true, nameEn: true, nameAr: true, allowsFraction: true } } } },
          fromBin: { select: { id: true, code: true } },
          toBin: { select: { id: true, code: true } },
        },
      },
      movements: {
        orderBy: [{ createdAt: "asc" }, { id: "asc" }],
        include: { warehouse: { select: { code: true } }, bin: { select: { code: true } }, product: { select: { sku: true } }, createdBy: { select: userSelect } },
      },
    },
  });
  if (!d) throw new NotFoundError("stock.errors.notFound");
  const costs = canSeeCosts(user);
  const perms = docPermissions(d.type, d.returnKind);
  const isDraft = d.status === "DRAFT";
  return {
    id: d.id,
    number: d.number,
    type: d.type,
    returnKind: d.returnKind,
    status: d.status,
    documentDate: keyOf(d.documentDate),
    from: d.fromWarehouse,
    to: d.toWarehouse,
    reference: d.reference,
    counterparty: d.counterparty,
    note: d.note,
    stocktake: d.stocktake,
    version: d.version,
    createdBy: d.createdBy,
    createdAt: d.createdAt.toISOString(),
    postedBy: d.postedBy,
    postedAt: d.postedAt?.toISOString() ?? null,
    cancelledBy: d.cancelledBy,
    cancelledAt: d.cancelledAt?.toISOString() ?? null,
    cancelReason: d.cancelReason,
    showCosts: costs,
    lines: d.lines.map((l) => ({
      id: l.id,
      lineNo: l.lineNo,
      product: l.product,
      quantity: num(l.quantity),
      unitCost: costs ? numOrNull(l.unitCost) : null,
      fromBin: l.fromBin,
      toBin: l.toBin,
      direction: l.direction,
      serials: l.serials,
      reason: l.reason,
    })),
    movements: d.movements.map((m) => ({
      id: m.id,
      type: m.type,
      sku: m.product.sku,
      warehouse: m.warehouse.code,
      bin: m.bin?.code ?? null,
      quantity: num(m.quantity),
      unitCost: costs ? num(m.unitCost) : null,
      balanceAfter: num(m.balanceAfter),
      serials: m.serials,
      reversesId: m.reversesId,
      createdAt: m.createdAt.toISOString(),
      createdBy: m.createdBy,
    })),
    can: {
      edit: isDraft && !d.stocktakeId && hasPermission(user, perms.prepare),
      post: isDraft && hasPermission(user, perms.post),
      cancelDraft: isDraft && !d.stocktakeId && (hasPermission(user, perms.prepare) || hasPermission(user, "inventory.approve")),
      reverse: d.status === "POSTED" && hasPermission(user, "inventory.approve"),
    },
  };
}
export type DocDetail = Awaited<ReturnType<typeof getDocument>>;

/** Which document types this user may prepare (the "New" menu). */
export function preparableTypes(user: CurrentUser): { type: StockDocType; returnKind: StockReturnKind | null }[] {
  const all: { type: StockDocType; returnKind: StockReturnKind | null }[] = [
    { type: "RECEIPT", returnKind: null },
    { type: "ISSUE", returnKind: null },
    { type: "TRANSFER", returnKind: null },
    { type: "RETURN", returnKind: "CUSTOMER" },
    { type: "RETURN", returnKind: "SUPPLIER" },
    { type: "ADJUSTMENT", returnKind: null },
    { type: "OPENING", returnKind: null },
  ];
  return all.filter((t) => hasPermission(user, docPermissions(t.type, t.returnKind).prepare));
}
