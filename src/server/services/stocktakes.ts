import "server-only";
import { Prisma, type StocktakeStatus } from "@prisma/client";
import { msg } from "@/i18n/translator";
import { STOCKTAKE_PREFIX, STOCKTAKE_STATUSES, formatDocNumber, DOC_PREFIX, stocktakeAddLineSchema, stocktakeCountSchema, stocktakeCreateSchema, stocktakeDecisionSchema } from "@/lib/inventory";
import { prisma, type Tx } from "../db";
import { assertCan, hasPermission } from "../access";
import type { CurrentUser } from "../auth/session";
import { NotFoundError, StaleRecordError, ValidationError } from "../errors";
import { recordAudit } from "./audit";
import { D, ZERO, checkId, dbDate, formError, lockWarehouses, nextSequence, num, pageOf, parseInput, productParam, today, warehouseScope } from "./inventory-common";
import { TX_OPTIONS, mapStockDbError, postInTx } from "./inventory-posting";

/**
 * Physical stocktakes. Starting one takes a snapshot of the warehouse's system quantities (and
 * serial numbers) and freezes the warehouse: no document can move its stock until the stocktake
 * is approved, rejected or cancelled. Counters enter what they find and explain differences;
 * the count is submitted for approval; approval posts one ADJUSTMENT document for the
 * differences, in the same transaction. Every step records who did it.
 */

const OPEN: StocktakeStatus[] = ["COUNTING", "SUBMITTED"];

async function lockStocktake(tx: Tx, id: string) {
  const rows = await tx.$queryRaw<{ id: string; warehouseId: string }[]>`SELECT "id", "warehouseId" FROM "stocktakes" WHERE "id" = ${id} FOR UPDATE`;
  if (!rows.length) throw new NotFoundError("stocktakes.errors.notFound");
  return rows[0]!;
}

async function visible(user: CurrentUser, id: string) {
  const st = await prisma.stocktake.findFirst({ where: { id: checkId(id), warehouse: warehouseScope(user) }, select: { id: true } });
  if (!st) throw new NotFoundError("stocktakes.errors.notFound");
}

export async function createStocktake(user: CurrentUser, raw: unknown, now = new Date()) {
  assertCan(user, "inventory.count");
  const { warehouseId, note } = parseInput(stocktakeCreateSchema, raw);
  try {
    return await prisma.$transaction(async (tx) => {
      // Exclusive: waits for postings in progress on this warehouse and keeps new ones out
      // until the snapshot is taken (they then see the stocktake and refuse).
      await lockWarehouses(tx, [warehouseId], "exclusive");
      const w = await tx.warehouse.findFirst({ where: { AND: [{ id: warehouseId }, warehouseScope(user)] } });
      if (!w || !w.isActive) throw new ValidationError({ warehouseId: msg("stock.errors.warehouse") });
      const open = await tx.stocktake.findFirst({ where: { warehouseId: w.id, status: { in: OPEN } }, select: { number: true } });
      if (open) throw new ValidationError({ warehouseId: msg("stocktakes.errors.alreadyOpen", { number: open.number }) }, msg("stocktakes.errors.alreadyOpen", { number: open.number }));
      const balances = await tx.stockBalance.findMany({ where: { warehouseId: w.id, quantity: { not: 0 } }, include: { product: { select: { trackSerials: true } } } });
      const serials = await tx.productSerial.findMany({ where: { warehouseId: w.id }, select: { productId: true, binId: true, serial: true }, orderBy: { serial: "asc" } });
      const serialsAt = new Map<string, string[]>();
      for (const s of serials) {
        const k = `${s.productId}|${s.binId ?? ""}`;
        serialsAt.set(k, [...(serialsAt.get(k) ?? []), s.serial]);
      }
      const year = Number(today(user, now).slice(0, 4));
      const number = formatDocNumber(STOCKTAKE_PREFIX, year, await nextSequence(tx, `${STOCKTAKE_PREFIX}-${year}`));
      const st = await tx.stocktake.create({
        data: {
          number,
          warehouseId: w.id,
          note,
          snapshotAt: now,
          createdById: user.id,
          createdAt: now,
          lines: {
            create: balances.map((b) => ({
              productId: b.productId,
              binId: b.binId,
              binKey: b.binKey,
              systemQuantity: b.quantity,
              systemSerials: b.product.trackSerials ? (serialsAt.get(`${b.productId}|${b.binKey}`) ?? []) : [],
            })),
          },
        },
      });
      await recordAudit(tx, {
        entityType: "STOCKTAKE",
        entityId: st.id,
        action: "STOCKTAKE_STARTED",
        summary: msg("audit.stocktakeStarted", { name: user.name, number, code: w.code }),
        changes: { warehouse: w.code, lines: balances.length },
        actorId: user.id,
      });
      return { id: st.id, number };
    }, TX_OPTIONS);
  } catch (e) {
    throw mapStockDbError(e);
  }
}

export type StocktakeFilters = { status?: string; warehouseId?: string; page?: number };

export async function listStocktakes(user: CurrentUser, f: StocktakeFilters) {
  if (!hasPermission(user, "inventory.count") && !hasPermission(user, "inventory.approve")) throw new NotFoundError();
  const pageSize = 25;
  const { page, skip, take } = pageOf(f.page, pageSize);
  const and: Prisma.StocktakeWhereInput[] = [{ warehouse: warehouseScope(user) }];
  if (f.status && (STOCKTAKE_STATUSES as string[]).includes(f.status)) and.push({ status: f.status as StocktakeStatus });
  if (f.warehouseId) and.push({ warehouseId: f.warehouseId });
  const where = { AND: and };
  const [total, rows] = await Promise.all([
    prisma.stocktake.count({ where }),
    prisma.stocktake.findMany({
      where,
      include: { warehouse: { select: { id: true, code: true, nameEn: true, nameAr: true } }, createdBy: { select: { id: true, name: true } }, _count: { select: { lines: true } } },
      orderBy: { createdAt: "desc" },
      skip,
      take,
    }),
  ]);
  return {
    total,
    page,
    pageSize,
    pageCount: Math.max(1, Math.ceil(total / pageSize)),
    rows: rows.map((s) => ({ id: s.id, number: s.number, status: s.status, warehouse: s.warehouse, createdBy: s.createdBy, createdAt: s.createdAt.toISOString(), lineCount: s._count.lines })),
  };
}

export async function getStocktake(user: CurrentUser, id: string) {
  if (!hasPermission(user, "inventory.count") && !hasPermission(user, "inventory.approve")) throw new NotFoundError();
  const s = await prisma.stocktake.findFirst({
    where: { id: checkId(id), warehouse: warehouseScope(user) },
    include: {
      warehouse: { select: { id: true, code: true, nameEn: true, nameAr: true, bins: { where: { isActive: true }, select: { id: true, code: true }, orderBy: { code: "asc" } } } },
      createdBy: { select: { id: true, name: true } },
      submittedBy: { select: { id: true, name: true } },
      decidedBy: { select: { id: true, name: true } },
      adjustment: { select: { id: true, number: true, status: true } },
      lines: {
        include: {
          product: { select: { id: true, sku: true, nameEn: true, nameAr: true, trackSerials: true, unit: { select: { code: true, allowsFraction: true } } } },
          bin: { select: { code: true } },
          countedBy: { select: { id: true, name: true } },
        },
        orderBy: [{ product: { sku: "asc" } }, { binKey: "asc" }],
      },
    },
  });
  if (!s) throw new NotFoundError("stocktakes.errors.notFound");
  const lines = s.lines.map((l) => {
    const system = num(l.systemQuantity);
    const counted = l.countedQuantity === null ? null : num(l.countedQuantity);
    return {
      id: l.id,
      product: l.product,
      bin: l.bin?.code ?? null,
      systemQuantity: system,
      systemSerials: l.systemSerials,
      countedQuantity: counted,
      countedSerials: l.countedSerials,
      difference: counted === null ? null : Math.round((counted - system) * 1000) / 1000,
      reason: l.reason,
      countedBy: l.countedBy,
      countedAt: l.countedAt?.toISOString() ?? null,
    };
  });
  return {
    id: s.id,
    number: s.number,
    status: s.status,
    warehouse: s.warehouse,
    note: s.note,
    snapshotAt: s.snapshotAt.toISOString(),
    createdBy: s.createdBy,
    createdAt: s.createdAt.toISOString(),
    submittedBy: s.submittedBy,
    submittedAt: s.submittedAt?.toISOString() ?? null,
    decidedBy: s.decidedBy,
    decidedAt: s.decidedAt?.toISOString() ?? null,
    decisionNote: s.decisionNote,
    adjustment: s.adjustment,
    version: s.version,
    lines,
    summary: {
      lines: lines.length,
      counted: lines.filter((l) => l.countedQuantity !== null).length,
      differences: lines.filter((l) => l.difference !== null && l.difference !== 0).length,
    },
    can: {
      count: s.status === "COUNTING" && hasPermission(user, "inventory.count"),
      submit: s.status === "COUNTING" && hasPermission(user, "inventory.count"),
      decide: s.status === "SUBMITTED" && hasPermission(user, "inventory.approve"),
      cancel: OPEN.includes(s.status) && (hasPermission(user, "inventory.approve") || (s.status === "COUNTING" && hasPermission(user, "inventory.count"))),
    },
  };
}
export type StocktakeDetail = Awaited<ReturnType<typeof getStocktake>>;

/** A counted line that does not match the snapshot (for serials: a different set, even of the same size). */
function differs(l: { countedQuantity: Prisma.Decimal | null; systemQuantity: Prisma.Decimal; countedSerials: string[]; systemSerials: string[]; product: { trackSerials: boolean } }) {
  if (l.countedQuantity === null) return false;
  if (!D(l.countedQuantity).equals(l.systemQuantity)) return true;
  if (!l.product.trackSerials) return false;
  const counted = new Set(l.countedSerials);
  return l.systemSerials.some((x) => !counted.has(x)) || l.countedSerials.length !== l.systemSerials.length;
}

async function assertStatus(tx: Tx, id: string, allowed: StocktakeStatus[]) {
  const s = await tx.stocktake.findUniqueOrThrow({ where: { id } });
  if (!allowed.includes(s.status)) throw formError("stocktakes.errors.wrongStatus", { status: `@enums.stocktakeStatus.${s.status}` });
  return s;
}

/** Saves counts for some lines (only while counting). Serial-tracked lines are counted by serial. */
export async function saveCounts(user: CurrentUser, id: string, raw: unknown, now = new Date()) {
  assertCan(user, "inventory.count");
  await visible(user, id);
  const { lines } = parseInput(stocktakeCountSchema, raw);
  await prisma.$transaction(async (tx) => {
    await lockStocktake(tx, id);
    await assertStatus(tx, id, ["COUNTING"]);
    const current = await tx.stocktakeLine.findMany({
      where: { stocktakeId: id, id: { in: lines.map((l) => l.lineId) } },
      include: { product: { select: { trackSerials: true, unit: { select: { allowsFraction: true, nameEn: true, nameAr: true } } } } },
    });
    const byId = new Map(current.map((l) => [l.id, l]));
    const errors: Record<string, string> = {};
    lines.forEach((l, i) => {
      const line = byId.get(l.lineId);
      if (!line) {
        errors[`lines.${i}.countedQuantity`] = msg("stocktakes.errors.line");
        return;
      }
      if (line.product.trackSerials) {
        if (l.countedQuantity !== null && l.countedQuantity !== l.countedSerials.length) errors[`lines.${i}.countedSerials`] = msg("stocktakes.errors.serialCount");
      } else {
        if (l.countedSerials.length) errors[`lines.${i}.countedSerials`] = msg("stock.errors.noSerials");
        if (l.countedQuantity !== null && !line.product.unit.allowsFraction && !Number.isInteger(l.countedQuantity)) {
          errors[`lines.${i}.countedQuantity`] = msg("stock.errors.wholeUnits", { unit: line.product.unit.nameEn, unitAr: line.product.unit.nameAr });
        }
      }
    });
    if (Object.keys(errors).length) throw new ValidationError(errors);
    for (const l of lines) {
      const line = byId.get(l.lineId)!;
      const counted = line.product.trackSerials && (l.countedQuantity !== null || l.countedSerials.length) ? l.countedSerials.length : l.countedQuantity;
      await tx.stocktakeLine.update({
        where: { id: line.id },
        data: {
          countedQuantity: counted,
          countedSerials: line.product.trackSerials ? l.countedSerials : [],
          reason: l.reason,
          countedById: counted === null ? null : user.id,
          countedAt: counted === null ? null : now,
        },
      });
    }
    await tx.stocktake.update({ where: { id }, data: { version: { increment: 1 } } });
  }, TX_OPTIONS);
  return getStocktake(user, id);
}

/** Adds a product found during the count that the snapshot did not list. */
export async function addStocktakeLine(user: CurrentUser, id: string, raw: unknown) {
  assertCan(user, "inventory.count");
  await visible(user, id);
  const { productId, binId } = parseInput(stocktakeAddLineSchema, raw);
  await prisma.$transaction(async (tx) => {
    const { warehouseId } = await lockStocktake(tx, id);
    await assertStatus(tx, id, ["COUNTING"]);
    const product = await tx.product.findUnique({ where: { id: productId }, select: { isActive: true } });
    if (!product?.isActive) throw new ValidationError({ productId: msg("stock.errors.product") });
    if (binId) {
      const bin = await tx.warehouseBin.findFirst({ where: { id: binId, warehouseId, isActive: true }, select: { id: true } });
      if (!bin) throw new ValidationError({ binId: msg("stock.errors.bin") });
    }
    const binKey = binId ?? "";
    const exists = await tx.stocktakeLine.findUnique({ where: { stocktakeId_productId_binKey: { stocktakeId: id, productId, binKey } }, select: { id: true } });
    if (exists) throw new ValidationError({ productId: msg("stocktakes.errors.lineExists") });
    const balance = await tx.stockBalance.findUnique({ where: { productId_warehouseId_binKey: { productId, warehouseId, binKey } }, select: { quantity: true } });
    await tx.stocktakeLine.create({ data: { stocktakeId: id, productId, binId, binKey, systemQuantity: balance?.quantity ?? ZERO } });
    await tx.stocktake.update({ where: { id }, data: { version: { increment: 1 } } });
  }, TX_OPTIONS);
  return getStocktake(user, id);
}

export async function submitStocktake(user: CurrentUser, id: string, raw: unknown, now = new Date()) {
  assertCan(user, "inventory.count");
  await visible(user, id);
  const version = (raw as { version?: unknown } | null)?.version;
  await prisma.$transaction(async (tx) => {
    await lockStocktake(tx, id);
    const s = await assertStatus(tx, id, ["COUNTING"]);
    if (typeof version === "number" && version !== s.version) throw new StaleRecordError();
    const lines = await tx.stocktakeLine.findMany({ where: { stocktakeId: id }, include: { product: { select: { sku: true, nameEn: true, nameAr: true, trackSerials: true } } } });
    const uncounted = lines.filter((l) => l.countedQuantity === null);
    if (uncounted.length) throw formError("stocktakes.errors.uncounted", { count: uncounted.length, ...productParam("product", uncounted[0]!.product) });
    const unexplained = lines.filter((l) => differs(l) && !l.reason);
    if (unexplained.length) throw formError("stocktakes.errors.unexplained", { count: unexplained.length, ...productParam("product", unexplained[0]!.product) });
    const w = await tx.warehouse.findUniqueOrThrow({ where: { id: s.warehouseId }, select: { code: true } });
    await tx.stocktake.update({ where: { id }, data: { status: "SUBMITTED", submittedById: user.id, submittedAt: now, version: { increment: 1 } } });
    await recordAudit(tx, {
      entityType: "STOCKTAKE",
      entityId: id,
      action: "STOCKTAKE_SUBMITTED",
      summary: msg("audit.stocktakeSubmitted", { name: user.name, number: s.number, code: w.code }),
      changes: { lines: lines.length, differences: lines.filter(differs).length },
      actorId: user.id,
    });
  }, TX_OPTIONS);
  return getStocktake(user, id);
}

/**
 * Approves a submitted count: posts one adjustment document (increase where more was found, a
 * decrease where less), linked to the stocktake, then closes the stocktake. All or nothing.
 */
export async function approveStocktake(user: CurrentUser, id: string, raw: unknown, now = new Date()) {
  assertCan(user, "inventory.approve");
  await visible(user, id);
  const { note } = parseInput(stocktakeDecisionSchema, raw);
  try {
    await prisma.$transaction(async (tx) => {
      const { warehouseId } = await lockStocktake(tx, id);
      const current = await tx.stocktake.findUniqueOrThrow({ where: { id } });
      if (current.status === "APPROVED") return; // approved already (a repeated click)
      await lockWarehouses(tx, [warehouseId], "exclusive");
      const s = await assertStatus(tx, id, ["SUBMITTED"]);
      const lines = await tx.stocktakeLine.findMany({
        where: { stocktakeId: id },
        include: { product: { select: { trackSerials: true } } },
        orderBy: [{ product: { sku: "asc" } }, { binKey: "asc" }],
      });
      const balances = await tx.stockBalance.findMany({ where: { warehouseId }, select: { productId: true, binKey: true, quantity: true } });
      const nowQty = new Map(balances.map((b) => [`${b.productId}|${b.binKey}`, D(b.quantity)]));
      // The warehouse was frozen, so the system quantities are still the snapshot's.
      for (const l of lines) {
        if (!(nowQty.get(`${l.productId}|${l.binKey}`) ?? ZERO).equals(l.systemQuantity)) throw formError("stocktakes.errors.changedSinceSnapshot");
      }
      const adjust = lines.flatMap((l) => {
        const counted = D(l.countedQuantity ?? l.systemQuantity);
        const diff = counted.minus(l.systemQuantity);
        if (l.product.trackSerials) {
          const missing = l.systemSerials.filter((x) => !l.countedSerials.includes(x));
          const extra = l.countedSerials.filter((x) => !l.systemSerials.includes(x));
          return [
            ...(missing.length ? [{ productId: l.productId, quantity: missing.length, direction: "DECREASE" as const, fromBinId: l.binId, toBinId: null, serials: missing, reason: l.reason }] : []),
            ...(extra.length ? [{ productId: l.productId, quantity: extra.length, direction: "INCREASE" as const, fromBinId: null, toBinId: l.binId, serials: extra, reason: l.reason }] : []),
          ];
        }
        if (diff.isZero()) return [];
        return [
          diff.isPositive()
            ? { productId: l.productId, quantity: diff.toNumber(), direction: "INCREASE" as const, fromBinId: null, toBinId: l.binId, serials: [], reason: l.reason }
            : { productId: l.productId, quantity: diff.abs().toNumber(), direction: "DECREASE" as const, fromBinId: l.binId, toBinId: null, serials: [], reason: l.reason },
        ];
      });
      const w = await tx.warehouse.findUniqueOrThrow({ where: { id: warehouseId }, select: { code: true } });
      let adjustmentNumber: string | null = null;
      if (adjust.length) {
        const dateKey = today(user, now);
        const year = Number(dateKey.slice(0, 4));
        adjustmentNumber = formatDocNumber(DOC_PREFIX.ADJUSTMENT, year, await nextSequence(tx, `${DOC_PREFIX.ADJUSTMENT}-${year}`));
        const doc = await tx.stockDocument.create({
          data: {
            number: adjustmentNumber,
            type: "ADJUSTMENT",
            toWarehouseId: warehouseId,
            documentDate: dbDate(dateKey),
            reference: s.number,
            note: note ?? null,
            stocktakeId: s.id,
            createdById: user.id,
            createdAt: now,
            lines: { create: adjust.map((a, i) => ({ ...a, lineNo: i + 1, reason: a.reason ?? s.number })) },
          },
        });
        await recordAudit(tx, {
          entityType: "INVENTORY",
          entityId: doc.id,
          action: "STOCK_DOC_CREATED",
          summary: msg("audit.stockDocCreated", { name: user.name, number: adjustmentNumber, type: "@enums.stockDocType.ADJUSTMENT" }),
          changes: { number: adjustmentNumber, lines: adjust.length, stocktake: s.number },
          actorId: user.id,
        });
        await postInTx(tx, user, doc.id, { now, asStocktakeApproval: true });
      }
      await tx.stocktake.update({ where: { id }, data: { status: "APPROVED", decidedById: user.id, decidedAt: now, decisionNote: note, version: { increment: 1 } } });
      await recordAudit(tx, {
        entityType: "STOCKTAKE",
        entityId: id,
        action: "STOCKTAKE_APPROVED",
        summary: adjustmentNumber
          ? msg("audit.stocktakeApproved", { name: user.name, number: s.number, code: w.code, adjustment: adjustmentNumber })
          : msg("audit.stocktakeApprovedNoChange", { name: user.name, number: s.number, code: w.code }),
        changes: { adjustment: adjustmentNumber, lines: adjust.length, note },
        actorId: user.id,
      });
    }, TX_OPTIONS);
  } catch (e) {
    throw mapStockDbError(e);
  }
  return getStocktake(user, id);
}

export async function rejectStocktake(user: CurrentUser, id: string, raw: unknown, now = new Date()) {
  assertCan(user, "inventory.approve");
  await visible(user, id);
  const { note } = parseInput(stocktakeDecisionSchema, raw);
  if (!note) throw new ValidationError({ note: msg("stocktakes.errors.rejectNote") }, msg("stocktakes.errors.rejectNote"));
  await prisma.$transaction(async (tx) => {
    await lockStocktake(tx, id);
    const s = await assertStatus(tx, id, ["SUBMITTED"]);
    const w = await tx.warehouse.findUniqueOrThrow({ where: { id: s.warehouseId }, select: { code: true } });
    await tx.stocktake.update({ where: { id }, data: { status: "REJECTED", decidedById: user.id, decidedAt: now, decisionNote: note, version: { increment: 1 } } });
    await recordAudit(tx, {
      entityType: "STOCKTAKE",
      entityId: id,
      action: "STOCKTAKE_REJECTED",
      summary: msg("audit.stocktakeRejected", { name: user.name, number: s.number, code: w.code }),
      changes: { note },
      actorId: user.id,
    });
  }, TX_OPTIONS);
  return getStocktake(user, id);
}

export async function cancelStocktake(user: CurrentUser, id: string, raw: unknown, now = new Date()) {
  if (!hasPermission(user, "inventory.approve")) assertCan(user, "inventory.count");
  await visible(user, id);
  const { note } = parseInput(stocktakeDecisionSchema, raw);
  await prisma.$transaction(async (tx) => {
    await lockStocktake(tx, id);
    const s = await assertStatus(tx, id, hasPermission(user, "inventory.approve") ? OPEN : ["COUNTING"]);
    const w = await tx.warehouse.findUniqueOrThrow({ where: { id: s.warehouseId }, select: { code: true } });
    await tx.stocktake.update({ where: { id }, data: { status: "CANCELLED", decidedById: user.id, decidedAt: now, decisionNote: note, version: { increment: 1 } } });
    await recordAudit(tx, {
      entityType: "STOCKTAKE",
      entityId: id,
      action: "STOCKTAKE_CANCELLED",
      summary: msg("audit.stocktakeCancelled", { name: user.name, number: s.number, code: w.code }),
      changes: { note },
      actorId: user.id,
    });
  }, TX_OPTIONS);
  return getStocktake(user, id);
}
