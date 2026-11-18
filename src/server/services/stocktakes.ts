import "server-only";
import { Prisma, type StocktakeStatus } from "@prisma/client";
import { msg } from "@/i18n/translator";
import { STOCKTAKE_PREFIX, STOCKTAKE_STATUSES, formatDocNumber, DOC_PREFIX, stocktakeAddLineSchema, stocktakeCountSchema, stocktakeDecisionSchema } from "@/lib/inventory";
import { plannedSessionSchema, recountSchema, stocktakeStartSchema } from "@/lib/stocktake-schedule";
import { computeEnd, zonedToUtc } from "@/lib/time";
import { prisma, type Tx } from "../db";
import { assertCan, hasPermission } from "../access";
import type { CurrentUser } from "../auth/session";
import { ForbiddenError, NotFoundError, StaleRecordError, ValidationError } from "../errors";
import { detectImageType, discardFile, MAX_UPLOAD_BYTES, readStoredFile, saveFile } from "../storage";
import { createHash } from "node:crypto";
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

/** Not started by its planned start, or not finished by its planned end. */
export function isOverdue(s: { status: StocktakeStatus; plannedStart: Date | null; plannedEnd: Date | null }, now = new Date()) {
  if (s.status === "PLANNED") return !!s.plannedStart && s.plannedStart < now;
  if (OPEN.includes(s.status)) return !!s.plannedEnd && s.plannedEnd < now;
  return false;
}

async function lockStocktake(tx: Tx, id: string) {
  const rows = await tx.$queryRaw<{ id: string; warehouseId: string }[]>`SELECT "id", "warehouseId" FROM "stocktakes" WHERE "id" = ${id} FOR UPDATE`;
  if (!rows.length) throw new NotFoundError("stocktakes.errors.notFound");
  return rows[0]!;
}

async function visible(user: CurrentUser, id: string) {
  const st = await prisma.stocktake.findFirst({ where: { id: checkId(id), warehouse: warehouseScope(user) }, select: { id: true } });
  if (!st) throw new NotFoundError("stocktakes.errors.notFound");
}

/** The products a stocktake counts: its products and the products of its categories (and subcategories). */
async function scopeProductIds(tx: Tx, categoryIds: string[], productIds: string[]): Promise<string[] | null> {
  if (!categoryIds.length && !productIds.length) return null;
  const inCategories = categoryIds.length
    ? await tx.product.findMany({ where: { OR: [{ categoryId: { in: categoryIds } }, { category: { parentId: { in: categoryIds } } }] }, select: { id: true } })
    : [];
  return [...new Set([...productIds, ...inCategories.map((p) => p.id)])];
}

/**
 * Takes the snapshot of a stocktake that is COUNTING (the warehouse is locked exclusively by the
 * caller): one line per product and bin with stock (limited to the stocktake's scope), with the
 * serial numbers there.
 */
async function takeSnapshot(tx: Tx, stocktakeId: string, warehouseId: string, scope: string[] | null) {
  const balances = await tx.stockBalance.findMany({
    where: { warehouseId, quantity: { not: 0 }, ...(scope ? { productId: { in: scope } } : {}) },
    include: { product: { select: { trackSerials: true, serialsOptional: true } } },
  });
  const serials = await tx.productSerial.findMany({ where: { warehouseId, ...(scope ? { productId: { in: scope } } : {}) }, select: { productId: true, binId: true, serial: true }, orderBy: { serial: "asc" } });
  const serialsAt = new Map<string, string[]>();
  for (const s of serials) {
    const k = `${s.productId}|${s.binId ?? ""}`;
    serialsAt.set(k, [...(serialsAt.get(k) ?? []), s.serial]);
  }
  if (balances.length) {
    await tx.stocktakeLine.createMany({
      data: balances.map((b) => ({
        stocktakeId,
        productId: b.productId,
        binId: b.binId,
        binKey: b.binKey,
        systemQuantity: b.quantity,
        systemSerials: b.product.trackSerials || b.product.serialsOptional ? (serialsAt.get(`${b.productId}|${b.binKey}`) ?? []) : [],
      })),
    });
  }
  return balances.length;
}

/** People named as assignees or supervisor must be active users (checked on every save). */
async function assertPeople(tx: Tx, assigneeIds: string[], supervisorId: string | null | undefined) {
  const ids = [...new Set([...assigneeIds, ...(supervisorId ? [supervisorId] : [])])];
  if (!ids.length) return;
  const found = await tx.user.findMany({ where: { id: { in: ids }, isActive: true }, select: { id: true } });
  const ok = new Set(found.map((u) => u.id));
  if (assigneeIds.some((id) => !ok.has(id))) throw new ValidationError({ assigneeIds: msg("stocktakePlan.errors.assignees") });
  if (supervisorId && !ok.has(supervisorId)) throw new ValidationError({ supervisorId: msg("stocktakePlan.errors.supervisor") });
}

async function assertScope(tx: Tx, categoryIds: string[], productIds: string[]) {
  if (categoryIds.length && (await tx.catalogCategory.count({ where: { id: { in: categoryIds } } })) !== new Set(categoryIds).size) throw new ValidationError({ categoryIds: msg("stocktakePlan.errors.categories") });
  if (productIds.length && (await tx.product.count({ where: { id: { in: productIds } } })) !== new Set(productIds).size) throw new ValidationError({ productIds: msg("stocktakePlan.errors.products") });
}

/** Starts a stocktake now (ad hoc): snapshot of the warehouse, or of the chosen categories and products. */
export async function createStocktake(user: CurrentUser, raw: unknown, now = new Date()) {
  assertCan(user, "inventory.count");
  const input = parseInput(stocktakeStartSchema, raw);
  const { warehouseId, note } = input;
  try {
    return await prisma.$transaction(async (tx) => {
      // Exclusive: waits for postings in progress on this warehouse and keeps new ones out
      // until the snapshot is taken (they then see the stocktake and refuse).
      await lockWarehouses(tx, [warehouseId], "exclusive");
      const w = await tx.warehouse.findFirst({ where: { AND: [{ id: warehouseId }, warehouseScope(user)] } });
      if (!w || !w.isActive) throw new ValidationError({ warehouseId: msg("stock.errors.warehouse") });
      const open = await tx.stocktake.findFirst({ where: { warehouseId: w.id, status: { in: OPEN } }, select: { number: true } });
      if (open) throw new ValidationError({ warehouseId: msg("stocktakes.errors.alreadyOpen", { number: open.number }) }, msg("stocktakes.errors.alreadyOpen", { number: open.number }));
      await assertPeople(tx, input.assigneeIds, input.supervisorId);
      await assertScope(tx, input.categoryIds, input.productIds);
      const year = Number(today(user, now).slice(0, 4));
      const number = formatDocNumber(STOCKTAKE_PREFIX, year, await nextSequence(tx, `${STOCKTAKE_PREFIX}-${year}`));
      const st = await tx.stocktake.create({
        data: {
          number,
          warehouseId: w.id,
          note: note ?? null,
          name: input.name ?? null,
          kind: (input.kind as "DAILY" | "MONTHLY" | "ANNUAL" | "CUSTOM" | undefined) ?? null,
          categoryIds: input.categoryIds,
          productIds: input.productIds,
          assigneeIds: input.assigneeIds,
          supervisorId: input.supervisorId ?? null,
          snapshotAt: now,
          startedAt: now,
          startedById: user.id,
          createdById: user.id,
          createdAt: now,
        },
      });
      const lines = await takeSnapshot(tx, st.id, w.id, await scopeProductIds(tx, input.categoryIds, input.productIds));
      await recordAudit(tx, {
        entityType: "STOCKTAKE",
        entityId: st.id,
        action: "STOCKTAKE_STARTED",
        summary: msg("audit.stocktakeStarted", { name: user.name, number, code: w.code }),
        changes: { warehouse: w.code, lines, ...(input.categoryIds.length || input.productIds.length ? { categories: input.categoryIds.length, products: input.productIds.length } : {}) },
        actorId: user.id,
      });
      return { id: st.id, number };
    }, TX_OPTIONS);
  } catch (e) {
    throw mapStockDbError(e);
  }
}

/** May this person count (and submit) this stocktake? Assignees only, when it has assignees; planners and approvers always. */
function mayCount(user: CurrentUser, s: { assigneeIds: string[] }) {
  if (!hasPermission(user, "inventory.count")) return false;
  if (!s.assigneeIds.length) return true;
  return s.assigneeIds.includes(user.id) || hasPermission(user, "inventory.approve") || hasPermission(user, "stocktakes.schedule");
}

function assertMayCount(user: CurrentUser, s: { assigneeIds: string[] }) {
  assertCan(user, "inventory.count");
  if (!mayCount(user, s)) throw new ForbiddenError("stocktakePlan.errors.notAssigned");
}

/** Starts a PLANNED session: takes the snapshot and freezes the warehouse, like an ad-hoc start. */
export async function startStocktake(user: CurrentUser, id: string, now = new Date()) {
  await visible(user, id);
  try {
    await prisma.$transaction(async (tx) => {
      const { warehouseId } = await lockStocktake(tx, id);
      await lockWarehouses(tx, [warehouseId], "exclusive");
      const s = await tx.stocktake.findUniqueOrThrow({ where: { id } });
      if (s.status === "COUNTING" && s.startedById) return; // started already (a repeated click)
      if (s.status !== "PLANNED") throw formError("stocktakes.errors.wrongStatus", { status: `@enums.stocktakeStatus.${s.status}` });
      assertMayCount(user, s);
      const w = await tx.warehouse.findUniqueOrThrow({ where: { id: warehouseId } });
      if (!w.isActive) throw new ValidationError({ _form: msg("stock.errors.warehouse") }, msg("stock.errors.warehouse"));
      const open = await tx.stocktake.findFirst({ where: { warehouseId, status: { in: OPEN }, id: { not: id } }, select: { number: true } });
      if (open) throw formError("stocktakes.errors.alreadyOpen", { number: open.number });
      await tx.stocktake.update({ where: { id }, data: { status: "COUNTING", snapshotAt: now, startedAt: now, startedById: user.id, version: { increment: 1 } } });
      const lines = await takeSnapshot(tx, id, warehouseId, await scopeProductIds(tx, s.categoryIds, s.productIds));
      await recordAudit(tx, {
        entityType: "STOCKTAKE",
        entityId: id,
        action: "STOCKTAKE_STARTED",
        summary: msg("audit.stocktakeStarted", { name: user.name, number: s.number, code: w.code }),
        changes: { warehouse: w.code, lines, planned: s.plannedStart?.toISOString() ?? null, late: !!(s.plannedEnd && now > s.plannedEnd) },
        actorId: user.id,
      });
    }, TX_OPTIONS);
  } catch (e) {
    throw mapStockDbError(e);
  }
  return getStocktake(user, id);
}

/**
 * Changes a PLANNED session: date and time, duration, assignees, supervisor, instructions. Moving
 * it later is a postponement and needs a reason; the original planned start is kept.
 */
export async function updatePlannedStocktake(user: CurrentUser, id: string, raw: unknown) {
  assertCan(user, "stocktakes.schedule");
  await visible(user, id);
  const v = parseInput(plannedSessionSchema, raw);
  await prisma.$transaction(async (tx) => {
    await lockStocktake(tx, id);
    const s = await assertStatus(tx, id, ["PLANNED"]);
    if (v.version !== undefined && v.version !== s.version) throw new StaleRecordError();
    await assertPeople(tx, v.assigneeIds, v.supervisorId);
    const plannedStart = zonedToUtc(v.date, v.startTime, user.settings.timezone);
    const plannedEnd = computeEnd(plannedStart, v.durationMinutes);
    const later = !!s.plannedStart && plannedStart > s.plannedStart;
    if (later && !v.reason) throw new ValidationError({ reason: msg("stocktakePlan.errors.postponeReason") });
    await tx.stocktake.update({
      where: { id },
      data: {
        plannedStart,
        plannedEnd,
        assigneeIds: v.assigneeIds,
        supervisorId: v.supervisorId,
        instructions: v.instructions === undefined ? s.instructions : v.instructions,
        mandatory: v.mandatory ?? s.mandatory,
        ...(later ? { postponedFrom: s.postponedFrom ?? s.plannedStart, postponeReason: v.reason } : {}),
        version: { increment: 1 },
      },
    });
    const w = await tx.warehouse.findUniqueOrThrow({ where: { id: s.warehouseId }, select: { code: true } });
    await recordAudit(tx, {
      entityType: "STOCKTAKE",
      entityId: id,
      action: later ? "STOCKTAKE_POSTPONED" : "STOCKTAKE_PLAN_CHANGED",
      summary: msg(later ? "stocktakePlan.audit.postponed" : "stocktakePlan.audit.changed", { name: user.name, number: s.number, code: w.code }),
      reason: v.reason ?? null,
      changes: {
        plannedStart: { from: s.plannedStart?.toISOString() ?? null, to: plannedStart.toISOString() },
        plannedEnd: { from: s.plannedEnd?.toISOString() ?? null, to: plannedEnd.toISOString() },
        assigneeIds: { from: s.assigneeIds, to: v.assigneeIds },
        supervisorId: { from: s.supervisorId, to: v.supervisorId },
      },
      actorId: user.id,
    });
  }, TX_OPTIONS);
  return getStocktake(user, id);
}

/** Warehouses (of those the user may see) that have a stocktake open: they are frozen. */
export async function frozenWarehouseIds(user: CurrentUser): Promise<Set<string>> {
  const rows = await prisma.stocktake.findMany({ where: { status: { in: OPEN }, warehouse: warehouseScope(user) }, select: { warehouseId: true } });
  return new Set(rows.map((r) => r.warehouseId));
}

export type StocktakeFilters = { status?: string; warehouseId?: string; page?: number; overdue?: boolean };

export async function listStocktakes(user: CurrentUser, f: StocktakeFilters) {
  if (!hasPermission(user, "inventory.count") && !hasPermission(user, "inventory.approve")) throw new NotFoundError();
  const pageSize = 25;
  const { page, skip, take } = pageOf(f.page, pageSize);
  const and: Prisma.StocktakeWhereInput[] = [{ warehouse: warehouseScope(user) }];
  if (f.status && (STOCKTAKE_STATUSES as string[]).includes(f.status)) and.push({ status: f.status as StocktakeStatus });
  if (f.warehouseId) and.push({ warehouseId: f.warehouseId });
  if (f.overdue) {
    const now = new Date();
    and.push({ OR: [{ status: "PLANNED", plannedStart: { lt: now } }, { status: { in: OPEN }, plannedEnd: { lt: now } }] });
  }
  const where = { AND: and };
  const [total, rows] = await Promise.all([
    prisma.stocktake.count({ where }),
    prisma.stocktake.findMany({
      where,
      include: { warehouse: { select: { id: true, code: true, nameEn: true, nameAr: true } }, createdBy: { select: { id: true, name: true } }, _count: { select: { lines: true } } },
      orderBy: [{ plannedStart: { sort: "desc", nulls: "last" } }, { createdAt: "desc" }],
      skip,
      take,
    }),
  ]);
  return {
    total,
    page,
    pageSize,
    pageCount: Math.max(1, Math.ceil(total / pageSize)),
    rows: rows.map((s) => ({
      id: s.id,
      number: s.number,
      status: s.status,
      name: s.name,
      kind: s.kind,
      warehouse: s.warehouse,
      createdBy: s.createdBy,
      createdAt: s.createdAt.toISOString(),
      plannedStart: s.plannedStart?.toISOString() ?? null,
      overdue: isOverdue(s),
      mandatory: s.mandatory,
      lineCount: s._count.lines,
    })),
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
      supervisor: { select: { id: true, name: true } },
      startedBy: { select: { id: true, name: true } },
      schedule: { select: { id: true, name: true, nameAr: true } },
      photos: { where: { deletedAt: null }, select: { id: true, lineId: true, uploadedById: true, createdAt: true, uploadedBy: { select: { name: true } } }, orderBy: { createdAt: "asc" } },
      counts: { select: { lineId: true, round: true, countedQuantity: true, countedSerials: true, damagedQuantity: true, reason: true, countedAt: true, countedBy: { select: { id: true, name: true } } }, orderBy: { countedAt: "asc" } },
      lines: {
        include: {
          product: { select: { id: true, sku: true, nameEn: true, nameAr: true, trackSerials: true, serialsOptional: true, unit: { select: { code: true, allowsFraction: true } } } },
          bin: { select: { code: true } },
          countedBy: { select: { id: true, name: true } },
        },
        orderBy: [{ product: { sku: "asc" } }, { binKey: "asc" }],
      },
    },
  });
  if (!s) throw new NotFoundError("stocktakes.errors.notFound");
  const historyOf = new Map<string, typeof s.counts>();
  for (const c of s.counts) historyOf.set(c.lineId, [...(historyOf.get(c.lineId) ?? []), c]);
  const lines = s.lines.map((l) => {
    const system = num(l.systemQuantity);
    const counted = l.countedQuantity === null ? null : num(l.countedQuantity);
    const diff = counted === null ? null : Math.round((counted - system) * 1000) / 1000;
    return {
      damagedQuantity: l.damagedQuantity === null ? null : num(l.damagedQuantity),
      missingQuantity: diff !== null && diff < 0 ? -diff : 0,
      excessQuantity: diff !== null && diff > 0 ? diff : 0,
      recountRequested: l.recountRequested,
      history: (historyOf.get(l.id) ?? []).map((c) => ({
        round: c.round,
        countedQuantity: c.countedQuantity === null ? null : num(c.countedQuantity),
        countedSerials: c.countedSerials,
        damagedQuantity: c.damagedQuantity === null ? null : num(c.damagedQuantity),
        reason: c.reason,
        countedAt: c.countedAt.toISOString(),
        countedBy: c.countedBy,
      })),
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
    snapshotAt: s.snapshotAt?.toISOString() ?? null,
    name: s.name,
    kind: s.kind,
    schedule: s.schedule,
    plannedStart: s.plannedStart?.toISOString() ?? null,
    plannedEnd: s.plannedEnd?.toISOString() ?? null,
    overdue: isOverdue(s),
    assignees: s.assigneeIds.length ? await prisma.user.findMany({ where: { id: { in: s.assigneeIds } }, select: { id: true, name: true }, orderBy: { name: "asc" } }) : [],
    supervisor: s.supervisor,
    categoryIds: s.categoryIds,
    productIds: s.productIds,
    mandatory: s.mandatory,
    instructions: s.instructions,
    startedAt: s.startedAt?.toISOString() ?? null,
    startedBy: s.startedBy,
    postponedFrom: s.postponedFrom?.toISOString() ?? null,
    postponeReason: s.postponeReason,
    round: s.round,
    photos: s.photos.map((p) => ({ id: p.id, url: `/api/stocktake-photos/${p.id}`, lineId: p.lineId, uploadedBy: p.uploadedBy.name, createdAt: p.createdAt.toISOString(), canRemove: OPEN.includes(s.status) && (p.uploadedById === user.id || hasPermission(user, "inventory.approve")) })),
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
      damaged: lines.reduce((a, l) => a + (l.damagedQuantity ?? 0), 0),
      missing: lines.reduce((a, l) => a + l.missingQuantity, 0),
      excess: lines.reduce((a, l) => a + l.excessQuantity, 0),
      recount: lines.filter((l) => l.recountRequested).length,
    },
    decisionBlocked: s.status === "SUBMITTED" && hasPermission(user, "inventory.approve") ? await approvalBlock(prisma as unknown as Tx, user, s) : null,
    can: {
      start: s.status === "PLANNED" && mayCount(user, s),
      editPlan: s.status === "PLANNED" && hasPermission(user, "stocktakes.schedule"),
      count: s.status === "COUNTING" && mayCount(user, s),
      submit: s.status === "COUNTING" && mayCount(user, s),
      decide: s.status === "SUBMITTED" && hasPermission(user, "inventory.approve"),
      recount: s.status === "SUBMITTED" && hasPermission(user, "inventory.approve"),
      photo: OPEN.includes(s.status) && (mayCount(user, s) || hasPermission(user, "inventory.approve")),
      cancel:
        (s.status === "PLANNED" && (hasPermission(user, "stocktakes.schedule") || hasPermission(user, "inventory.approve"))) ||
        (OPEN.includes(s.status) && (hasPermission(user, "inventory.approve") || (s.status === "COUNTING" && mayCount(user, s)))),
    },
  };
}
export type StocktakeDetail = Awaited<ReturnType<typeof getStocktake>>;

/** A counted line that does not match the snapshot (for serials: a different set, even of the same size). */
function differs(l: { countedQuantity: Prisma.Decimal | null; systemQuantity: Prisma.Decimal; countedSerials: string[]; systemSerials: string[]; product: { trackSerials: boolean; serialsOptional?: boolean } }) {
  if (l.countedQuantity === null) return false;
  if (!D(l.countedQuantity).equals(l.systemQuantity)) return true;
  // Optional serials are compared only when the counter listed the serials found.
  if (!l.product.trackSerials && !(l.product.serialsOptional && l.countedSerials.length)) return false;
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
    const take = await assertStatus(tx, id, ["COUNTING"]);
    assertMayCount(user, take);
    const current = await tx.stocktakeLine.findMany({
      where: { stocktakeId: id, id: { in: lines.map((l) => l.lineId) } },
      include: { product: { select: { trackSerials: true, serialsOptional: true, unit: { select: { allowsFraction: true, nameEn: true, nameAr: true } } } } },
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
      } else if (line.product.serialsOptional) {
        const qty = l.countedQuantity ?? (l.countedSerials.length || null);
        if (qty !== null && !Number.isInteger(qty)) errors[`lines.${i}.countedQuantity`] = msg("stock.errors.wholeUnits", { unit: line.product.unit.nameEn, unitAr: line.product.unit.nameAr });
        if (qty !== null && l.countedSerials.length > qty) errors[`lines.${i}.countedSerials`] = msg("serialModes.tooManySerials", { count: qty, given: l.countedSerials.length });
      } else {
        if (l.countedSerials.length) errors[`lines.${i}.countedSerials`] = msg("stock.errors.noSerials");
        if (l.countedQuantity !== null && !line.product.unit.allowsFraction && !Number.isInteger(l.countedQuantity)) {
          errors[`lines.${i}.countedQuantity`] = msg("stock.errors.wholeUnits", { unit: line.product.unit.nameEn, unitAr: line.product.unit.nameAr });
        }
      }
      const dmg = l.damagedQuantity ?? null;
      if (dmg !== null) {
        const qty = line.product.trackSerials ? l.countedSerials.length : l.countedQuantity;
        if (qty === null || qty === undefined || dmg > qty) errors[`lines.${i}.damagedQuantity`] = msg("stocktakePlan.errors.damaged");
        else if (!line.product.unit.allowsFraction && !Number.isInteger(dmg)) errors[`lines.${i}.damagedQuantity`] = msg("stock.errors.wholeUnits", { unit: line.product.unit.nameEn, unitAr: line.product.unit.nameAr });
      }
    });
    if (Object.keys(errors).length) throw new ValidationError(errors);
    for (const l of lines) {
      const line = byId.get(l.lineId)!;
      const counted =
        line.product.trackSerials && (l.countedQuantity !== null || l.countedSerials.length)
          ? l.countedSerials.length
          : line.product.serialsOptional
            ? (l.countedQuantity ?? (l.countedSerials.length || null))
            : l.countedQuantity;
      const serials = line.product.trackSerials || line.product.serialsOptional ? l.countedSerials : [];
      const damaged = counted === null ? null : (l.damagedQuantity ?? null);
      await tx.stocktakeLine.update({
        where: { id: line.id },
        data: {
          countedQuantity: counted,
          countedSerials: serials,
          reason: l.reason,
          damagedQuantity: damaged,
          countedById: counted === null ? null : user.id,
          countedAt: counted === null ? null : now,
          // A recount asked for by the approver is done once the line is counted again.
          ...(counted !== null ? { recountRequested: false } : {}),
        },
      });
      // Every count and recount is kept as entered (append-only history).
      if (counted !== null) {
        await tx.stocktakeCount.create({
          data: { stocktakeId: id, lineId: line.id, round: take.round, countedQuantity: counted, countedSerials: serials, damagedQuantity: damaged, reason: l.reason ?? null, countedById: user.id, countedAt: now },
        });
      }
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
    assertMayCount(user, await assertStatus(tx, id, ["COUNTING"]));
    const product = await tx.product.findUnique({ where: { id: productId }, select: { isActive: true, hasVariants: true, sku: true, nameEn: true, nameAr: true } });
    if (!product?.isActive) throw new ValidationError({ productId: msg("stock.errors.product") });
    if (product.hasVariants) throw new ValidationError({ productId: msg("variants.errors.pickVariant", productParam("product", product)) });
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
    assertMayCount(user, s);
    if (typeof version === "number" && version !== s.version) throw new StaleRecordError();
    const lines = await tx.stocktakeLine.findMany({ where: { stocktakeId: id }, include: { product: { select: { sku: true, nameEn: true, nameAr: true, trackSerials: true, serialsOptional: true } } } });
    const toRecount = lines.filter((l) => l.recountRequested);
    if (toRecount.length) throw formError("stocktakePlan.errors.recountPending", { count: toRecount.length, ...productParam("product", toRecount[0]!.product) });
    const uncounted = lines.filter((l) => l.countedQuantity === null);
    if (uncounted.length) throw formError("stocktakes.errors.uncounted", { count: uncounted.length, ...productParam("product", uncounted[0]!.product) });
    // Optional serials: fewer units than recorded serials means some serials are gone, and only
    // the counter can say which.
    const unnamed = lines.find((l) => l.product.serialsOptional && !l.countedSerials.length && D(l.countedQuantity!).lessThan(l.systemSerials.length));
    if (unnamed) throw formError("serialModes.listSerialsFound", { ...productParam("product", unnamed.product), count: unnamed.systemSerials.length });
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
      const blocked = await approvalBlock(tx, user, s);
      if (blocked) throw new ForbiddenError(blocked);
      const lines = await tx.stocktakeLine.findMany({
        where: { stocktakeId: id },
        include: { product: { select: { trackSerials: true, serialsOptional: true } } },
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
        if (l.product.serialsOptional && l.countedSerials.length) {
          // Missing serials leave, extra serials come in, and plain units make up the rest so
          // the count ends at what was counted.
          const missing = l.systemSerials.filter((x) => !l.countedSerials.includes(x));
          const extra = l.countedSerials.filter((x) => !l.systemSerials.includes(x));
          const plain = D(l.systemQuantity).minus(counted).minus(missing.length).plus(extra.length);
          const out = D(missing.length).plus(Prisma.Decimal.max(plain, 0));
          const into = D(extra.length).plus(Prisma.Decimal.max(plain.negated(), 0));
          return [
            ...(out.greaterThan(0) ? [{ productId: l.productId, quantity: out.toNumber(), direction: "DECREASE" as const, fromBinId: l.binId, toBinId: null, serials: missing, reason: l.reason }] : []),
            ...(into.greaterThan(0) ? [{ productId: l.productId, quantity: into.toNumber(), direction: "INCREASE" as const, fromBinId: null, toBinId: l.binId, serials: extra, reason: l.reason }] : []),
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
    const blocked = await approvalBlock(tx, user, s);
    if (blocked) throw new ForbiddenError(blocked);
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
  if (!hasPermission(user, "inventory.approve") && !hasPermission(user, "stocktakes.schedule")) assertCan(user, "inventory.count");
  await visible(user, id);
  const { note } = parseInput(stocktakeDecisionSchema, raw);
  await prisma.$transaction(async (tx) => {
    await lockStocktake(tx, id);
    // Planned sessions: planners and approvers. Open stocktakes: approvers; counters while counting.
    const allowed: StocktakeStatus[] = [
      ...(hasPermission(user, "stocktakes.schedule") || hasPermission(user, "inventory.approve") ? (["PLANNED"] as StocktakeStatus[]) : []),
      ...(hasPermission(user, "inventory.approve") ? OPEN : hasPermission(user, "inventory.count") ? (["COUNTING"] as StocktakeStatus[]) : []),
    ];
    const s = await assertStatus(tx, id, allowed);
    if (s.status === "PLANNED" && s.mandatory && !note) throw new ValidationError({ note: msg("stocktakePlan.errors.mandatoryCancel") }, msg("stocktakePlan.errors.mandatoryCancel"));
    if (s.status === "COUNTING" && !hasPermission(user, "inventory.approve")) assertMayCount(user, s);
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

/**
 * Why this person may not approve or reject this stocktake (null when they may):
 *   - separation of duties (setting, on by default): not the person who submitted it nor anyone
 *     who counted any line of it, in any round;
 *   - a session with a supervisor: the supervisor, or someone who plans stocktakes.
 */
async function approvalBlock(tx: Tx, user: CurrentUser, s: { id: string; submittedById: string | null; supervisorId: string | null }) {
  if (s.supervisorId && s.supervisorId !== user.id && !hasPermission(user, "stocktakes.schedule")) return "stocktakePlan.errors.supervisorOnly";
  if (user.settings.stocktakeIndependentApproval) {
    if (s.submittedById === user.id) return "stocktakePlan.errors.ownSubmission";
    const counted = await tx.stocktakeCount.findFirst({ where: { stocktakeId: s.id, countedById: user.id }, select: { id: true } });
    if (counted) return "stocktakePlan.errors.ownCount";
  }
  return null;
}

/**
 * Sends a submitted count back for a recount (of some lines, or all): the stocktake returns to
 * counting in a new round; every earlier count stays in the history; the snapshot is unchanged.
 */
export async function returnForRecount(user: CurrentUser, id: string, raw: unknown) {
  assertCan(user, "inventory.approve");
  await visible(user, id);
  const { note, lineIds } = parseInput(recountSchema, raw);
  await prisma.$transaction(async (tx) => {
    await lockStocktake(tx, id);
    const s = await assertStatus(tx, id, ["SUBMITTED"]);
    const blocked = await approvalBlock(tx, user, s);
    if (blocked) throw new ForbiddenError(blocked);
    // Back to counting first: lines can change only while counting (trigger).
    await tx.stocktake.update({ where: { id }, data: { status: "COUNTING", round: { increment: 1 }, submittedById: null, submittedAt: null, decisionNote: note, version: { increment: 1 } } });
    const where = lineIds.length ? { stocktakeId: id, id: { in: lineIds } } : { stocktakeId: id };
    const flagged = await tx.stocktakeLine.updateMany({ where, data: { recountRequested: true } });
    if (lineIds.length && flagged.count !== new Set(lineIds).size) throw new ValidationError({ lineIds: msg("stocktakes.errors.line") });
    const w = await tx.warehouse.findUniqueOrThrow({ where: { id: s.warehouseId }, select: { code: true } });
    await recordAudit(tx, {
      entityType: "STOCKTAKE",
      entityId: id,
      action: "STOCKTAKE_RECOUNT",
      summary: msg("stocktakePlan.audit.recount", { name: user.name, number: s.number, code: w.code, count: flagged.count }),
      reason: note,
      changes: { round: { from: s.round, to: s.round + 1 }, lines: flagged.count, submittedBy: s.submittedById },
      actorId: user.id,
    });
  }, TX_OPTIONS);
  return getStocktake(user, id);
}

// ---------------------------------------------------------------------------------------------
// Photos
// ---------------------------------------------------------------------------------------------

export const MAX_STOCKTAKE_PHOTOS = 40;

/** Adds a supporting photo (optionally of one line) while the stocktake is open. */
export async function uploadStocktakePhoto(user: CurrentUser, id: string, lineId: string | null, bytes: Uint8Array | null) {
  await visible(user, id);
  if (!bytes || !bytes.length) throw new ValidationError({ file: msg("attachments.errors.type") }, msg("attachments.errors.type"));
  if (bytes.length > MAX_UPLOAD_BYTES) throw new ValidationError({ file: msg("attachments.errors.tooLarge") }, msg("attachments.errors.tooLarge"));
  const type = detectImageType(bytes);
  if (!type) throw new ValidationError({ file: msg("attachments.errors.type") }, msg("attachments.errors.type"));
  const s = await prisma.stocktake.findUniqueOrThrow({ where: { id } });
  if (!OPEN.includes(s.status)) throw formError("stocktakes.errors.wrongStatus", { status: `@enums.stocktakeStatus.${s.status}` });
  if (!(mayCount(user, s) || hasPermission(user, "inventory.approve"))) throw new ForbiddenError("stocktakePlan.errors.notAssigned");
  if (lineId && !(await prisma.stocktakeLine.findFirst({ where: { id: lineId, stocktakeId: id }, select: { id: true } }))) throw new ValidationError({ lineId: msg("stocktakes.errors.line") });
  if ((await prisma.stocktakePhoto.count({ where: { stocktakeId: id, deletedAt: null } })) >= MAX_STOCKTAKE_PHOTOS) throw formError("stocktakePlan.errors.tooManyPhotos", { count: MAX_STOCKTAKE_PHOTOS });
  const key = await saveFile(bytes, type);
  try {
    const row = await prisma.$transaction(async (tx) => {
      const p = await tx.stocktakePhoto.create({ data: { stocktakeId: id, lineId, contentType: type, byteSize: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex"), storageKey: key, uploadedById: user.id } });
      await recordAudit(tx, { entityType: "STOCKTAKE", entityId: id, action: "STOCKTAKE_PHOTO_ADDED", summary: msg("stocktakePlan.audit.photo", { name: user.name, number: s.number }), changes: { photo: p.id, lineId }, actorId: user.id });
      return p;
    });
    return { id: row.id, url: `/api/stocktake-photos/${row.id}`, lineId: row.lineId };
  } catch (e) {
    await discardFile(key);
    throw e;
  }
}

export async function readStocktakePhoto(user: CurrentUser, photoId: string) {
  const p = await prisma.stocktakePhoto.findUnique({ where: { id: checkId(photoId) } });
  if (!p || p.deletedAt) throw new NotFoundError();
  if (!hasPermission(user, "inventory.count") && !hasPermission(user, "inventory.approve")) throw new NotFoundError();
  await visible(user, p.stocktakeId);
  return { bytes: await readStoredFile(p.storageKey), contentType: p.contentType };
}

/** Marks a photo as removed (its uploader or an approver, while the stocktake is open). The file is kept. */
export async function removeStocktakePhoto(user: CurrentUser, photoId: string, now = new Date()) {
  const p = await prisma.stocktakePhoto.findUnique({ where: { id: checkId(photoId) }, include: { stocktake: { select: { status: true, number: true } } } });
  if (!p || p.deletedAt) throw new NotFoundError();
  await visible(user, p.stocktakeId);
  if (p.uploadedById !== user.id && !hasPermission(user, "inventory.approve")) throw new ForbiddenError();
  if (!OPEN.includes(p.stocktake.status)) throw formError("stocktakes.errors.wrongStatus", { status: `@enums.stocktakeStatus.${p.stocktake.status}` });
  await prisma.$transaction(async (tx) => {
    await tx.stocktakePhoto.update({ where: { id: p.id }, data: { deletedAt: now, deletedById: user.id } });
    await recordAudit(tx, { entityType: "STOCKTAKE", entityId: p.stocktakeId, action: "STOCKTAKE_PHOTO_REMOVED", summary: msg("stocktakePlan.audit.photoRemoved", { name: user.name, number: p.stocktake.number }), changes: { photo: p.id }, actorId: user.id });
  });
}

