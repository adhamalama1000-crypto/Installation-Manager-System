import "server-only";
import { Prisma, type InventoryMovementType } from "@prisma/client";
import { createT } from "@/i18n/translator";
import { MOVEMENT_TYPES } from "@/lib/inventory";
import { isValidDateString } from "@/lib/time";
import { prisma } from "../db";
import { assertCan, hasPermission } from "../access";
import type { CurrentUser } from "../auth/session";
import { NotFoundError } from "../errors";
import { toCsv } from "./reports";
import { isVehicleScoped } from "@/lib/permissions";
import { canSeeCosts, checkId, dbDate, keyOf, likeTerm, num, pageOf, warehouseScope, warehouseScopeSql } from "./inventory-common";

/**
 * Reading stock: balances (per product, or per product and location), low stock, value at
 * average cost, the ledger, and CSV exports of both. Everything is paginated in the database
 * and scoped to the warehouses the reader may see (technicians: their vehicle).
 */

export type BalanceFilters = { view?: string; warehouseId?: string; q?: string; categoryId?: string; low?: string; page?: number };

export type BalanceRow = {
  productId: string;
  sku: string;
  nameEn: string;
  nameAr: string;
  unitCode: string;
  unitEn: string;
  unitAr: string;
  trackSerials: boolean;
  /** Only in the per-location view. */
  warehouse: { id: string; code: string; nameEn: string; nameAr: string } | null;
  bin: string | null;
  quantity: number;
  minStock: number;
  low: boolean;
  value: number | null;
};

function balanceConditions(user: CurrentUser, f: BalanceFilters): Prisma.Sql {
  const conds: Prisma.Sql[] = [warehouseScopeSql(user, "w")];
  if (f.warehouseId) conds.push(Prisma.sql`b."warehouseId" = ${checkId(f.warehouseId)}`);
  const q = f.q?.trim().slice(0, 100);
  if (q) {
    const code = likeTerm(q.replace(/\s+/g, "").toUpperCase());
    const text = likeTerm(q);
    conds.push(Prisma.sql`(p."sku" LIKE ${code} OR p."barcode" = ${q.replace(/\s+/g, "").toUpperCase()} OR p."nameEn" ILIKE ${text} OR p."nameAr" ILIKE ${text})`);
  }
  if (f.categoryId) conds.push(Prisma.sql`(p."categoryId" = ${f.categoryId} OR p."categoryId" IN (SELECT "id" FROM "catalog_categories" WHERE "parentId" = ${f.categoryId}))`);
  return Prisma.join(conds, " AND ");
}

export async function listBalances(user: CurrentUser, f: BalanceFilters) {
  assertCan(user, "inventory.view");
  const pageSize = 50;
  const { page, skip, take } = pageOf(f.page, pageSize);
  const byLocation = f.view === "location";
  const costs = canSeeCosts(user);
  const where = balanceConditions(user, f);
  // The minimum stock is a company-wide threshold: low stock compares it with the total over all
  // warehouses, so it is shown only on the overall view (not per warehouse or for a vehicle).
  const overall = !f.warehouseId && !isVehicleScoped(user.role);
  const low = overall && f.low === "1";
  const rows = byLocation
    ? await prisma.$queryRaw<(Omit<BalanceRow, "warehouse" | "low" | "value" | "quantity" | "minStock"> & { quantity: Prisma.Decimal; minStock: Prisma.Decimal; averageCost: Prisma.Decimal; wId: string; wCode: string; wNameEn: string; wNameAr: string; total: bigint })[]>`
        SELECT p."id" AS "productId", p."sku", p."nameEn", p."nameAr", u."code" AS "unitCode", u."nameEn" AS "unitEn", u."nameAr" AS "unitAr", p."trackSerials",
               w."id" AS "wId", w."code" AS "wCode", w."nameEn" AS "wNameEn", w."nameAr" AS "wNameAr", bn."code" AS "bin",
               b."quantity", p."minStock", p."averageCost", COUNT(*) OVER() AS total
        FROM "stock_balances" b
        JOIN "products" p ON p."id" = b."productId"
        JOIN "units" u ON u."id" = p."unitId"
        JOIN "warehouses" w ON w."id" = b."warehouseId"
        LEFT JOIN "warehouse_bins" bn ON bn."id" = b."binId"
        WHERE ${where} AND b."quantity" <> 0
        ORDER BY p."sku", w."code", COALESCE(bn."code", '')
        LIMIT ${take} OFFSET ${skip}`
    : await prisma.$queryRaw<(Omit<BalanceRow, "warehouse" | "bin" | "low" | "value" | "quantity" | "minStock"> & { quantity: Prisma.Decimal; minStock: Prisma.Decimal; averageCost: Prisma.Decimal; total: bigint })[]>`
        SELECT p."id" AS "productId", p."sku", p."nameEn", p."nameAr", u."code" AS "unitCode", u."nameEn" AS "unitEn", u."nameAr" AS "unitAr", p."trackSerials",
               COALESCE(SUM(b."quantity"), 0) AS "quantity", p."minStock", p."averageCost", COUNT(*) OVER() AS total
        FROM "products" p
        JOIN "units" u ON u."id" = p."unitId"
        LEFT JOIN "stock_balances" b ON b."productId" = p."id" AND b."warehouseId" IN (SELECT w."id" FROM "warehouses" w WHERE ${warehouseScopeSql(user, "w")})
          ${f.warehouseId ? Prisma.sql`AND b."warehouseId" = ${checkId(f.warehouseId)}` : Prisma.empty}
        WHERE p."isActive" AND ${productConditions(f)}
        GROUP BY p."id", u."id"
        HAVING ${
          low
            ? Prisma.sql`p."minStock" > 0 AND COALESCE(SUM(b."quantity"), 0) < p."minStock"`
            : overall
              ? Prisma.sql`COALESCE(SUM(b."quantity"), 0) <> 0 OR p."minStock" > 0`
              : Prisma.sql`COALESCE(SUM(b."quantity"), 0) <> 0`
        }
        ORDER BY p."sku"
        LIMIT ${take} OFFSET ${skip}`;
  const total = rows.length ? Number(rows[0]!.total) : 0;
  const totals = costs ? await stockValue(user, f) : null;
  return {
    total,
    page,
    pageSize,
    pageCount: Math.max(1, Math.ceil(total / pageSize)),
    totalValue: totals,
    lowAvailable: overall,
    rows: rows.map((r): BalanceRow => {
      const quantity = num(r.quantity);
      const minStock = num(r.minStock);
      const loc = r as unknown as { wId?: string; wCode: string; wNameEn: string; wNameAr: string; bin?: string | null };
      return {
        productId: r.productId,
        sku: r.sku,
        nameEn: r.nameEn,
        nameAr: r.nameAr,
        unitCode: r.unitCode,
        unitEn: r.unitEn,
        unitAr: r.unitAr,
        trackSerials: r.trackSerials,
        warehouse: loc.wId ? { id: loc.wId, code: loc.wCode, nameEn: loc.wNameEn, nameAr: loc.wNameAr } : null,
        bin: loc.bin ?? null,
        quantity,
        minStock,
        low: overall && !byLocation && minStock > 0 && quantity < minStock,
        value: costs ? Math.round(quantity * num(r.averageCost) * 100) / 100 : null,
      };
    }),
  };
}

function productConditions(f: BalanceFilters): Prisma.Sql {
  const conds: Prisma.Sql[] = [Prisma.sql`TRUE`];
  const q = f.q?.trim().slice(0, 100);
  if (q) {
    const code = q.replace(/\s+/g, "").toUpperCase();
    const text = likeTerm(q);
    conds.push(Prisma.sql`(p."sku" LIKE ${likeTerm(code)} OR p."barcode" = ${code} OR p."nameEn" ILIKE ${text} OR p."nameAr" ILIKE ${text})`);
  }
  if (f.categoryId) conds.push(Prisma.sql`(p."categoryId" = ${f.categoryId} OR p."categoryId" IN (SELECT "id" FROM "catalog_categories" WHERE "parentId" = ${f.categoryId}))`);
  return Prisma.join(conds, " AND ");
}

/** Value of the stock the filters select, at average cost. */
async function stockValue(user: CurrentUser, f: BalanceFilters): Promise<number> {
  const [row] = await prisma.$queryRaw<{ value: Prisma.Decimal | null }[]>`
    SELECT SUM(b."quantity" * p."averageCost") AS value
    FROM "stock_balances" b JOIN "products" p ON p."id" = b."productId" JOIN "warehouses" w ON w."id" = b."warehouseId"
    WHERE ${balanceConditions(user, f)}`;
  return Math.round(num(row?.value) * 100) / 100;
}

/** Availability of one product at one warehouse, per bin (the document form shows it next to a line). */
export async function availability(user: CurrentUser, productId: string, warehouseId: string) {
  assertCan(user, "inventory.view");
  const w = await prisma.warehouse.findFirst({ where: { AND: [{ id: checkId(warehouseId) }, warehouseScope(user)] }, select: { id: true } });
  if (!w) throw new NotFoundError();
  const [rows, serials] = await Promise.all([
    prisma.stockBalance.findMany({ where: { productId: checkId(productId), warehouseId: w.id }, select: { binId: true, quantity: true, bin: { select: { code: true } } } }),
    prisma.productSerial.findMany({ where: { productId, warehouseId: w.id }, select: { serial: true, binId: true }, orderBy: { serial: "asc" }, take: 500 }),
  ]);
  return {
    total: rows.reduce((s, r) => s + num(r.quantity), 0),
    bins: rows.map((r) => ({ binId: r.binId, code: r.bin?.code ?? null, quantity: num(r.quantity) })),
    serials,
  };
}

// ---- Ledger ----------------------------------------------------------------------------------

export type LedgerFilters = { productId?: string; warehouseId?: string; type?: string; q?: string; from?: string; to?: string; page?: number };

function ledgerWhere(user: CurrentUser, f: LedgerFilters): Prisma.InventoryMovementWhereInput {
  const and: Prisma.InventoryMovementWhereInput[] = [{ warehouse: warehouseScope(user) }];
  if (f.productId) and.push({ productId: checkId(f.productId) });
  if (f.warehouseId) and.push({ warehouseId: checkId(f.warehouseId) });
  if (f.type && (MOVEMENT_TYPES as string[]).includes(f.type)) and.push({ type: f.type as InventoryMovementType });
  if (f.from && isValidDateString(f.from)) and.push({ documentDate: { gte: dbDate(f.from) } });
  if (f.to && isValidDateString(f.to)) and.push({ documentDate: { lte: dbDate(f.to) } });
  const q = f.q?.trim().slice(0, 100);
  if (q) {
    const code = q.replace(/\s+/g, "").toUpperCase();
    and.push({ OR: [{ document: { number: { contains: code } } }, { product: { sku: { contains: code } } }, { serials: { has: code } }] });
  }
  return { AND: and };
}

const ledgerInclude = {
  product: { select: { id: true, sku: true, nameEn: true, nameAr: true, unit: { select: { code: true } } } },
  warehouse: { select: { id: true, code: true } },
  bin: { select: { code: true } },
  document: { select: { id: true, number: true, type: true, returnKind: true, reference: true } },
  createdBy: { select: { id: true, name: true } },
} satisfies Prisma.InventoryMovementInclude;

export async function listMovements(user: CurrentUser, f: LedgerFilters) {
  assertCan(user, "inventory.view");
  const pageSize = 50;
  const { page, skip, take } = pageOf(f.page, pageSize);
  const where = ledgerWhere(user, f);
  const costs = canSeeCosts(user);
  const [total, rows] = await Promise.all([
    prisma.inventoryMovement.count({ where }),
    prisma.inventoryMovement.findMany({ where, include: ledgerInclude, orderBy: [{ createdAt: "desc" }, { id: "asc" }], skip, take }),
  ]);
  return {
    total,
    page,
    pageSize,
    pageCount: Math.max(1, Math.ceil(total / pageSize)),
    rows: rows.map((m) => ({
      id: m.id,
      type: m.type,
      createdAt: m.createdAt.toISOString(),
      documentDate: keyOf(m.documentDate),
      product: m.product,
      warehouse: m.warehouse,
      bin: m.bin?.code ?? null,
      quantity: num(m.quantity),
      balanceAfter: num(m.balanceAfter),
      unitCost: costs ? num(m.unitCost) : null,
      serials: m.serials,
      reason: m.reason,
      reversesId: m.reversesId,
      document: m.document,
      createdBy: m.createdBy,
    })),
  };
}
export type LedgerRow = Awaited<ReturnType<typeof listMovements>>["rows"][number];

// ---- Exports ---------------------------------------------------------------------------------

const EXPORT_LIMIT = 20_000;

export async function exportBalancesCsv(user: CurrentUser, f: BalanceFilters): Promise<string> {
  assertCan(user, "inventory.reports");
  const t = createT(user.locale);
  const out: unknown[][] = [];
  const view = f.view === "location" ? "location" : "product";
  out.push([
    t("stock.fields.sku"),
    t("stock.fields.product"),
    t("stock.fields.unit"),
    ...(view === "location" ? [t("stock.fields.warehouse"), t("stock.fields.bin")] : []),
    t("stock.fields.quantity"),
    t("stock.fields.minStock"),
    t("stock.fields.value"),
  ]);
  for (let page = 1; out.length <= EXPORT_LIMIT; page++) {
    const r = await listBalances(user, { ...f, view, page });
    for (const b of r.rows) {
      out.push([
        b.sku,
        t.locale === "ar" ? b.nameAr : b.nameEn,
        b.unitCode,
        ...(view === "location" ? [b.warehouse?.code ?? "", b.bin ?? ""] : []),
        b.quantity,
        b.minStock,
        b.value ?? "",
      ]);
    }
    if (page >= r.pageCount) break;
  }
  return toCsv(out);
}

export async function exportLedgerCsv(user: CurrentUser, f: LedgerFilters): Promise<string> {
  assertCan(user, "inventory.reports");
  const t = createT(user.locale);
  const where = ledgerWhere(user, f);
  const rows = await prisma.inventoryMovement.findMany({ where, include: ledgerInclude, orderBy: [{ createdAt: "asc" }, { id: "asc" }], take: EXPORT_LIMIT });
  return toCsv([
    [
      t("stock.fields.postedAt"),
      t("stock.fields.documentDate"),
      t("stock.fields.document"),
      t("stock.fields.movementType"),
      t("stock.fields.sku"),
      t("stock.fields.product"),
      t("stock.fields.warehouse"),
      t("stock.fields.bin"),
      t("stock.fields.quantity"),
      t("stock.fields.balanceAfter"),
      t("stock.fields.unitCost"),
      t("stock.fields.serials"),
      t("stock.fields.reason"),
      t("stock.fields.by"),
    ],
    ...rows.map((m) => [
      m.createdAt.toISOString(),
      keyOf(m.documentDate),
      m.document.number,
      t.dyn(`enums.movementType.${m.type}`),
      m.product.sku,
      t.locale === "ar" ? m.product.nameAr : m.product.nameEn,
      m.warehouse.code,
      m.bin?.code ?? "",
      num(m.quantity),
      num(m.balanceAfter),
      num(m.unitCost),
      m.serials.join(" "),
      m.reason ?? "",
      m.createdBy.name,
    ]),
  ]);
}

export function canExport(user: CurrentUser) {
  return hasPermission(user, "inventory.reports");
}
