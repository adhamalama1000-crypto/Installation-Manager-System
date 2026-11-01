import "server-only";
import { Prisma, type WarehouseKind } from "@prisma/client";
import { msg } from "@/i18n/translator";
import { binSchema, warehouseSchema } from "@/lib/inventory";
import { prisma } from "../db";
import { assertCan, hasPermission } from "../access";
import type { CurrentUser } from "../auth/session";
import { NotFoundError, StaleRecordError, ValidationError } from "../errors";
import { diffValues, recordAudit } from "./audit";
import { isUniqueViolation } from "./scheduling";
import { canSeeCosts, canViewInventory, checkId, num, pageOf, parseInput, warehouseScope } from "./inventory-common";

/**
 * Warehouses, technicians' vehicles (warehouses of kind VEHICLE linked to one technician) and
 * their bins. Vehicles are created by hand for the technicians who carry stock; none is created
 * automatically. A warehouse or bin is deactivated, never deleted, and only once it is empty.
 */

const include = {
  technician: { select: { id: true, name: true, isActive: true } },
  _count: { select: { bins: true } },
} satisfies Prisma.WarehouseInclude;
type Row = Prisma.WarehouseGetPayload<{ include: typeof include }>;

export type WarehouseDTO = {
  id: string;
  code: string;
  nameEn: string;
  nameAr: string;
  kind: WarehouseKind;
  technician: { id: string; name: string; isActive: boolean } | null;
  address: string | null;
  allowNegative: boolean;
  isActive: boolean;
  version: number;
  binCount: number;
  /** Products with stock here (non-zero lines). */
  productCount: number;
  /** Stock value at average cost; null when the reader may not see costs. */
  value: number | null;
  openStocktake: { id: string; number: string } | null;
};

async function summaries(user: CurrentUser, ids: string[]) {
  if (!ids.length) return { counts: new Map<string, number>(), values: new Map<string, number>(), open: new Map<string, { id: string; number: string }>() };
  const [stats, open] = await Promise.all([
    prisma.$queryRaw<{ warehouseId: string; products: bigint; value: Prisma.Decimal | null }[]>`
      SELECT b."warehouseId", COUNT(DISTINCT b."productId") FILTER (WHERE b."quantity" <> 0) AS products,
             SUM(b."quantity" * p."averageCost") AS value
      FROM "stock_balances" b JOIN "products" p ON p."id" = b."productId"
      WHERE b."warehouseId" IN (${Prisma.join(ids)})
      GROUP BY b."warehouseId"`,
    prisma.stocktake.findMany({ where: { warehouseId: { in: ids }, status: { in: ["COUNTING", "SUBMITTED"] } }, select: { id: true, number: true, warehouseId: true } }),
  ]);
  const costs = canSeeCosts(user);
  return {
    counts: new Map(stats.map((s) => [s.warehouseId, Number(s.products)])),
    values: new Map(costs ? stats.map((s) => [s.warehouseId, Math.round(num(s.value) * 100) / 100]) : []),
    open: new Map(open.map((o) => [o.warehouseId, { id: o.id, number: o.number }])),
  };
}

function toDTO(user: CurrentUser, w: Row, s: Awaited<ReturnType<typeof summaries>>): WarehouseDTO {
  return {
    id: w.id,
    code: w.code,
    nameEn: w.nameEn,
    nameAr: w.nameAr,
    kind: w.kind,
    technician: w.technician,
    address: w.address,
    allowNegative: w.allowNegative,
    isActive: w.isActive,
    version: w.version,
    binCount: w._count.bins,
    productCount: s.counts.get(w.id) ?? 0,
    value: canSeeCosts(user) ? (s.values.get(w.id) ?? 0) : null,
    openStocktake: s.open.get(w.id) ?? null,
  };
}

export type WarehouseFilters = { q?: string; kind?: string; active?: string; page?: number };

export async function listWarehouses(user: CurrentUser, f: WarehouseFilters = {}) {
  if (!canViewInventory(user)) throw new NotFoundError();
  const pageSize = 25;
  const { page, skip, take } = pageOf(f.page, pageSize);
  const and: Prisma.WarehouseWhereInput[] = [warehouseScope(user)];
  const q = f.q?.trim().slice(0, 100);
  if (q) and.push({ OR: [{ code: { contains: q.toUpperCase() } }, { nameEn: { contains: q, mode: "insensitive" } }, { nameAr: { contains: q } }, { technician: { name: { contains: q, mode: "insensitive" } } }] });
  if (f.kind === "WAREHOUSE" || f.kind === "VEHICLE") and.push({ kind: f.kind });
  if (f.active !== "all") and.push({ isActive: f.active !== "0" });
  const where: Prisma.WarehouseWhereInput = { AND: and };
  const [total, rows] = await Promise.all([
    prisma.warehouse.count({ where }),
    prisma.warehouse.findMany({ where, include, orderBy: [{ kind: "asc" }, { code: "asc" }], skip, take }),
  ]);
  const s = await summaries(user, rows.map((r) => r.id));
  return { total, page, pageSize, pageCount: Math.max(1, Math.ceil(total / pageSize)), rows: rows.map((r) => toDTO(user, r, s)) };
}

/** Every active warehouse the user may see (pickers on documents, stocktakes and filters). */
export async function warehouseOptions(user: CurrentUser, opts: { includeInactive?: boolean } = {}) {
  if (!canViewInventory(user)) return [];
  return prisma.warehouse.findMany({
    where: { AND: [warehouseScope(user), opts.includeInactive ? {} : { isActive: true }] },
    select: {
      id: true,
      code: true,
      nameEn: true,
      nameAr: true,
      kind: true,
      isActive: true,
      allowNegative: true,
      technician: { select: { name: true } },
      bins: { where: { isActive: true }, select: { id: true, code: true, name: true }, orderBy: { code: "asc" } },
    },
    orderBy: [{ kind: "asc" }, { code: "asc" }],
  });
}
export type WarehouseOption = Awaited<ReturnType<typeof warehouseOptions>>[number];

export type BinDTO = { id: string; code: string; name: string | null; isActive: boolean; productCount: number };

export async function getWarehouse(user: CurrentUser, id: string) {
  if (!canViewInventory(user)) throw new NotFoundError();
  const w = await prisma.warehouse.findFirst({ where: { AND: [{ id: checkId(id) }, warehouseScope(user)] }, include });
  if (!w) throw new NotFoundError();
  const [s, bins, binCounts] = await Promise.all([
    summaries(user, [w.id]),
    prisma.warehouseBin.findMany({ where: { warehouseId: w.id }, orderBy: { code: "asc" } }),
    prisma.stockBalance.groupBy({ by: ["binId"], where: { warehouseId: w.id, quantity: { not: 0 }, binId: { not: null } }, _count: { _all: true } }),
  ]);
  const perBin = new Map(binCounts.map((b) => [b.binId, b._count._all]));
  return {
    ...toDTO(user, w, s),
    bins: bins.map((b): BinDTO => ({ id: b.id, code: b.code, name: b.name, isActive: b.isActive, productCount: perBin.get(b.id) ?? 0 })),
  };
}

async function hasStock(tx: Prisma.TransactionClient, where: Prisma.StockBalanceWhereInput) {
  return !!(await tx.stockBalance.findFirst({ where: { ...where, quantity: { not: 0 } }, select: { id: true } }));
}

export async function saveWarehouse(user: CurrentUser, id: string | null, raw: unknown) {
  assertCan(user, "warehouses.manage");
  const { version, ...data } = parseInput(warehouseSchema, raw);
  try {
    const saved = await prisma.$transaction(async (tx) => {
      const before = id ? await tx.warehouse.findUnique({ where: { id: checkId(id) } }) : null;
      if (id && !before) throw new NotFoundError();
      if (before && version !== undefined && version !== before.version) throw new StaleRecordError();
      const errors: Record<string, string> = {};
      if (data.technicianId) {
        const tech = await tx.user.findUnique({ where: { id: data.technicianId }, select: { role: true, isActive: true } });
        if (!tech || tech.role !== "TECHNICIAN" || (!tech.isActive && data.technicianId !== before?.technicianId)) errors.technicianId = msg("warehouses.errors.technician");
        const other = await tx.warehouse.findFirst({ where: { technicianId: data.technicianId, id: before ? { not: before.id } : undefined }, select: { code: true } });
        if (other) errors.technicianId = msg("warehouses.errors.technicianHasVehicle", { code: other.code });
      }
      if (before) {
        if (before.kind !== data.kind && (await hasStock(tx, { warehouseId: before.id }))) errors.kind = msg("warehouses.errors.kindWithStock");
        if (before.isActive && !data.isActive && (await hasStock(tx, { warehouseId: before.id }))) errors.isActive = msg("warehouses.errors.deactivateWithStock");
        if (before.allowNegative && !data.allowNegative) {
          const negative = await tx.stockBalance.findFirst({ where: { warehouseId: before.id, quantity: { lt: 0 } }, select: { id: true } });
          if (negative) errors.allowNegative = msg("warehouses.errors.negativeExists");
        }
      }
      const dup = await tx.warehouse.findFirst({ where: { code: data.code, id: before ? { not: before.id } : undefined }, select: { id: true } });
      if (dup) errors.code = msg("warehouses.errors.codeTaken");
      if (Object.keys(errors).length) throw new ValidationError(errors);

      const w = before
        ? await tx.warehouse.update({ where: { id: before.id }, data: { ...data, version: { increment: 1 } } })
        : await tx.warehouse.create({ data: { ...data, createdById: user.id } });
      await recordAudit(tx, {
        entityType: "WAREHOUSE",
        entityId: w.id,
        action: before ? "WAREHOUSE_UPDATED" : "WAREHOUSE_CREATED",
        summary: msg(before ? "audit.warehouseUpdated" : "audit.warehouseCreated", { name: user.name, code: w.code }),
        changes: before
          ? diffValues(before, w, ["code", "nameEn", "nameAr", "kind", "technicianId", "address", "allowNegative", "isActive"])
          : { code: w.code, nameEn: w.nameEn, nameAr: w.nameAr, kind: w.kind, technicianId: w.technicianId, allowNegative: w.allowNegative },
        actorId: user.id,
      });
      return w;
    });
    return getWarehouse(user, saved.id);
  } catch (e) {
    if (isUniqueViolation(e, "code")) throw new ValidationError({ code: msg("warehouses.errors.codeTaken") });
    if (isUniqueViolation(e, "technicianId")) throw new ValidationError({ technicianId: msg("warehouses.errors.technicianHasVehicle", { code: "" }) });
    throw e;
  }
}

export async function saveBin(user: CurrentUser, warehouseId: string, binId: string | null, raw: unknown): Promise<BinDTO> {
  assertCan(user, "warehouses.manage");
  const data = parseInput(binSchema, raw);
  try {
    return await prisma.$transaction(async (tx) => {
      const w = await tx.warehouse.findUnique({ where: { id: checkId(warehouseId) } });
      if (!w) throw new NotFoundError();
      const before = binId ? await tx.warehouseBin.findFirst({ where: { id: checkId(binId), warehouseId: w.id } }) : null;
      if (binId && !before) throw new NotFoundError();
      if (before && before.isActive && !data.isActive && (await hasStock(tx, { binId: before.id }))) {
        throw new ValidationError({ isActive: msg("warehouses.errors.binWithStock") });
      }
      if (before && before.code !== data.code && (await tx.inventoryMovement.findFirst({ where: { binId: before.id }, select: { id: true } }))) {
        throw new ValidationError({ code: msg("warehouses.errors.binCodeLocked") });
      }
      const b = before ? await tx.warehouseBin.update({ where: { id: before.id }, data }) : await tx.warehouseBin.create({ data: { ...data, warehouseId: w.id } });
      await recordAudit(tx, {
        entityType: "WAREHOUSE",
        entityId: w.id,
        action: before ? "BIN_UPDATED" : "BIN_CREATED",
        summary: msg(before ? "audit.binUpdated" : "audit.binCreated", { name: user.name, code: w.code, bin: b.code }),
        changes: before ? diffValues(before, b, ["code", "name", "isActive"]) : { code: b.code, name: b.name },
        actorId: user.id,
      });
      const count = await tx.stockBalance.count({ where: { binId: b.id, quantity: { not: 0 } } });
      return { id: b.id, code: b.code, name: b.name, isActive: b.isActive, productCount: count };
    });
  } catch (e) {
    if (isUniqueViolation(e)) throw new ValidationError({ code: msg("warehouses.errors.binTaken") });
    throw e;
  }
}

/** Active technicians, for the vehicle form (with the vehicle each already has). */
export async function technicianOptions(user: CurrentUser) {
  assertCan(user, "warehouses.manage");
  return prisma.user.findMany({
    where: { role: "TECHNICIAN", isActive: true },
    select: { id: true, name: true, vehicle: { select: { id: true, code: true } } },
    orderBy: { name: "asc" },
  });
}

export function canManageWarehouses(user: CurrentUser) {
  return hasPermission(user, "warehouses.manage");
}
