import "server-only";
import { Prisma } from "@prisma/client";
import { addDaysToKey, isValidDateString } from "@/lib/time";
import { prisma } from "../db";
import { assertCan } from "../access";
import type { CurrentUser } from "../auth/session";
import { canSeeCosts, checkId, dbDate, today } from "./inventory-common";

/**
 * Sales and product analytics. Every sales figure comes from CONFIRMED sales invoices
 * (sales_invoices / sales_invoice_lines) and nothing else: stock movements of any kind (issues to
 * technicians or sites, transfers, adjustments, returns) are never read as sales. Stock figures
 * (on hand, value, slow-moving, low stock) come from the balances. Aggregation happens in SQL, one
 * statement per block, all in parallel.
 */

export type AnalyticsFilters = { from?: string; to?: string; categoryId?: string; brandId?: string; warehouseId?: string; productId?: string; rollUp?: boolean; slowDays?: number };

const n = (v: unknown) => (v === null || v === undefined ? 0 : Number(v));

export async function salesAnalytics(user: CurrentUser, f: AnalyticsFilters, now = new Date()) {
  assertCan(user, "analytics.view");
  const costs = canSeeCosts(user);
  const todayKey = today(user, now);
  const to = f.to && isValidDateString(f.to) ? f.to : todayKey;
  const from = f.from && isValidDateString(f.from) && f.from <= to ? f.from : `${to.slice(0, 4)}-01-01`;
  const days = Math.max(1, Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000) + 1);
  const rollUp = f.rollUp !== false;
  const slowDays = Math.min(730, Math.max(7, f.slowDays ?? 90));
  const categoryId = f.categoryId ? checkId(f.categoryId) : null;
  const brandId = f.brandId ? checkId(f.brandId) : null;
  const warehouseId = f.warehouseId ? checkId(f.warehouseId) : null;
  const productId = f.productId ? checkId(f.productId) : null;

  // Product filters (p = the stock-keeping product, c = its category).
  const productWhere = Prisma.sql`TRUE
    ${categoryId ? Prisma.sql`AND (p."categoryId" = ${categoryId} OR c."parentId" = ${categoryId})` : Prisma.empty}
    ${brandId ? Prisma.sql`AND p."brandId" = ${brandId}` : Prisma.empty}
    ${productId ? Prisma.sql`AND (p.id = ${productId} OR p."parentId" = ${productId})` : Prisma.empty}`;
  const soldWhere = (a: string, b: string) => Prisma.sql`i.status = 'CONFIRMED' AND i."invoiceDate" >= ${dbDate(a)} AND i."invoiceDate" <= ${dbDate(b)}
    ${warehouseId ? Prisma.sql`AND i."warehouseId" = ${warehouseId}` : Prisma.empty} AND ${productWhere}`;
  const sold = (a: string, b: string) => Prisma.sql`
    SELECT l."productId", COALESCE(p."parentId", p.id) AS "groupId", l.quantity, l."lineTotal", COALESCE(l."unitCost", 0) * l.quantity AS cost,
           i."invoiceDate", i.id AS "invoiceId", p."categoryId", c."parentId" AS "parentCategoryId", p."brandId"
    FROM sales_invoice_lines l
    JOIN sales_invoices i ON i.id = l."invoiceId"
    JOIN products p ON p.id = l."productId"
    LEFT JOIN catalog_categories c ON c.id = p."categoryId"
    WHERE ${soldWhere(a, b)}`;
  const key = rollUp ? Prisma.sql`s."groupId"` : Prisma.sql`s."productId"`;
  // Stock per stock-keeping product, in the chosen warehouse (or all warehouses the reader sees).
  const stock = Prisma.sql`
    SELECT b."productId", SUM(b.quantity) AS qty FROM stock_balances b
    ${warehouseId ? Prisma.sql`WHERE b."warehouseId" = ${warehouseId}` : Prisma.empty}
    GROUP BY b."productId"`;

  const lastYear = Number(to.slice(0, 4)) - 1;
  const [totals, byProduct, byCategory, byBrand, monthly, yearly, noSales, slow, low, valuation] = await Promise.all([
    prisma.$queryRaw<{ revenue: Prisma.Decimal | null; qty: Prisma.Decimal | null; invoices: bigint; cost: Prisma.Decimal | null }[]>`
      WITH s AS (${sold(from, to)}) SELECT SUM(s."lineTotal") AS revenue, SUM(s.quantity) AS qty, COUNT(DISTINCT s."invoiceId") AS invoices, SUM(s.cost) AS cost FROM s`,
    prisma.$queryRaw<{ id: string; sku: string; nameEn: string; nameAr: string; unit: string; qty: Prisma.Decimal; revenue: Prisma.Decimal; cost: Prisma.Decimal; last: Date; onHand: Prisma.Decimal | null; avgCost: Prisma.Decimal | null }[]>`
      WITH s AS (${sold(from, to)}), st AS (${stock}),
      g AS (SELECT ${key} AS id, SUM(s.quantity) AS qty, SUM(s."lineTotal") AS revenue, SUM(s.cost) AS cost, MAX(s."invoiceDate") AS last FROM s GROUP BY 1)
      SELECT g.id, p.sku, p."nameEn", p."nameAr", u.code AS unit, g.qty, g.revenue, g.cost, g.last,
             (SELECT SUM(st.qty) FROM st JOIN products v ON v.id = st."productId" WHERE v.id = g.id OR v."parentId" = g.id) AS "onHand",
             (SELECT CASE WHEN SUM(st.qty) > 0 THEN SUM(st.qty * v."averageCost") / SUM(st.qty) END FROM st JOIN products v ON v.id = st."productId" WHERE v.id = g.id OR v."parentId" = g.id) AS "avgCost"
      FROM g JOIN products p ON p.id = g.id JOIN units u ON u.id = p."unitId"
      ORDER BY g.qty DESC, g.revenue DESC`,
    prisma.$queryRaw<{ id: string | null; nameEn: string | null; nameAr: string | null; qty: Prisma.Decimal; revenue: Prisma.Decimal }[]>`
      WITH s AS (${sold(from, to)})
      SELECT COALESCE(s."parentCategoryId", s."categoryId") AS id, c."nameEn", c."nameAr", SUM(s.quantity) AS qty, SUM(s."lineTotal") AS revenue
      FROM s LEFT JOIN catalog_categories c ON c.id = COALESCE(s."parentCategoryId", s."categoryId")
      GROUP BY 1, 2, 3 ORDER BY revenue DESC`,
    prisma.$queryRaw<{ id: string | null; name: string | null; qty: Prisma.Decimal; revenue: Prisma.Decimal }[]>`
      WITH s AS (${sold(from, to)})
      SELECT s."brandId" AS id, b.name, SUM(s.quantity) AS qty, SUM(s."lineTotal") AS revenue
      FROM s LEFT JOIN brands b ON b.id = s."brandId" GROUP BY 1, 2 ORDER BY revenue DESC`,
    prisma.$queryRaw<{ month: string; qty: Prisma.Decimal; revenue: Prisma.Decimal; invoices: bigint }[]>`
      WITH s AS (${sold(from, to)})
      SELECT to_char(s."invoiceDate", 'YYYY-MM') AS month, SUM(s.quantity) AS qty, SUM(s."lineTotal") AS revenue, COUNT(DISTINCT s."invoiceId") AS invoices
      FROM s GROUP BY 1 ORDER BY 1`,
    prisma.$queryRaw<{ year: number; month: number; revenue: Prisma.Decimal; qty: Prisma.Decimal }[]>`
      WITH s AS (${sold(`${lastYear}-01-01`, `${lastYear + 1}-12-31`)})
      SELECT EXTRACT(YEAR FROM s."invoiceDate")::int AS year, EXTRACT(MONTH FROM s."invoiceDate")::int AS month, SUM(s."lineTotal") AS revenue, SUM(s.quantity) AS qty
      FROM s GROUP BY 1, 2 ORDER BY 1, 2`,
    // Active stock-keeping products that sold nothing in the period, most stock value first.
    prisma.$queryRaw<{ id: string; sku: string; nameEn: string; nameAr: string; unit: string; onHand: Prisma.Decimal | null; value: Prisma.Decimal | null; total: bigint }[]>`
      WITH s AS (${sold(from, to)}), st AS (${stock})
      SELECT p.id, p.sku, p."nameEn", p."nameAr", u.code AS unit, st.qty AS "onHand", st.qty * p."averageCost" AS value, COUNT(*) OVER () AS total
      FROM products p JOIN units u ON u.id = p."unitId" LEFT JOIN catalog_categories c ON c.id = p."categoryId" LEFT JOIN st ON st."productId" = p.id
      WHERE p."isActive" AND NOT p."hasVariants" AND ${productWhere} AND NOT EXISTS (SELECT 1 FROM s WHERE s."productId" = p.id)
      ORDER BY value DESC NULLS LAST, p.sku LIMIT 25`,
    // In stock, but no confirmed sale for slowDays (ever, or since).
    prisma.$queryRaw<{ id: string; sku: string; nameEn: string; nameAr: string; unit: string; onHand: Prisma.Decimal; value: Prisma.Decimal; lastSold: Date | null; total: bigint }[]>`
      WITH st AS (${stock}),
      lastsale AS (SELECT l."productId", MAX(i."invoiceDate") AS d FROM sales_invoice_lines l JOIN sales_invoices i ON i.id = l."invoiceId" WHERE i.status = 'CONFIRMED' GROUP BY 1)
      SELECT p.id, p.sku, p."nameEn", p."nameAr", u.code AS unit, st.qty AS "onHand", st.qty * p."averageCost" AS value, ls.d AS "lastSold", COUNT(*) OVER () AS total
      FROM st JOIN products p ON p.id = st."productId" JOIN units u ON u.id = p."unitId" LEFT JOIN catalog_categories c ON c.id = p."categoryId" LEFT JOIN lastsale ls ON ls."productId" = p.id
      WHERE st.qty > 0 AND ${productWhere} AND (ls.d IS NULL OR ls.d < ${dbDate(addDaysToKey(todayKey, -slowDays))})
      ORDER BY value DESC, p.sku LIMIT 25`,
    prisma.$queryRaw<{ id: string; sku: string; nameEn: string; nameAr: string; unit: string; onHand: Prisma.Decimal; minStock: Prisma.Decimal; total: bigint }[]>`
      WITH tot AS (SELECT b."productId", SUM(b.quantity) AS qty FROM stock_balances b GROUP BY 1)
      SELECT p.id, p.sku, p."nameEn", p."nameAr", u.code AS unit, COALESCE(tot.qty, 0) AS "onHand", p."minStock", COUNT(*) OVER () AS total
      FROM products p JOIN units u ON u.id = p."unitId" LEFT JOIN catalog_categories c ON c.id = p."categoryId" LEFT JOIN tot ON tot."productId" = p.id
      WHERE p."isActive" AND NOT p."hasVariants" AND p."minStock" > 0 AND COALESCE(tot.qty, 0) < p."minStock" AND ${productWhere}
      ORDER BY (COALESCE(tot.qty, 0) / p."minStock"), p.sku LIMIT 25`,
    prisma.$queryRaw<{ id: string; code: string; nameEn: string; nameAr: string; value: Prisma.Decimal; qty: Prisma.Decimal }[]>`
      SELECT w.id, w.code, w."nameEn", w."nameAr", SUM(b.quantity * p."averageCost") AS value, SUM(b.quantity) AS qty
      FROM stock_balances b JOIN warehouses w ON w.id = b."warehouseId" JOIN products p ON p.id = b."productId" LEFT JOIN catalog_categories c ON c.id = p."categoryId"
      WHERE b.quantity <> 0 AND ${productWhere} ${warehouseId ? Prisma.sql`AND w.id = ${warehouseId}` : Prisma.empty}
      GROUP BY 1, 2, 3, 4 ORDER BY value DESC`,
  ]);

  const t = totals[0]!;
  const revenue = n(t.revenue);
  const cogs = n(t.cost);
  const stockValue = valuation.reduce((s, w) => s + n(w.value), 0);
  const products = byProduct.map((r) => {
    const qty = n(r.qty);
    const onHand = n(r.onHand);
    const value = onHand * n(r.avgCost);
    return {
      id: r.id,
      sku: r.sku,
      nameEn: r.nameEn,
      nameAr: r.nameAr,
      unit: r.unit,
      qty,
      revenue: n(r.revenue),
      cost: costs ? n(r.cost) : null,
      margin: costs ? n(r.revenue) - n(r.cost) : null,
      lastSold: r.last.toISOString().slice(0, 10),
      onHand,
      turnover: costs && value > 0 ? Math.round((n(r.cost) / value) * 100) / 100 : null,
      daysOfCover: qty > 0 ? Math.round(onHand / (qty / days)) : null,
    };
  });
  const year = Number(to.slice(0, 4));
  const yearSeries = (y: number) => Array.from({ length: 12 }, (_, m) => n(yearly.find((r) => r.year === y && r.month === m + 1)?.revenue));
  return {
    from,
    to,
    days,
    rollUp,
    slowDays,
    showCosts: costs,
    totals: {
      revenue,
      qty: n(t.qty),
      invoices: Number(t.invoices),
      avgInvoice: Number(t.invoices) ? Math.round((revenue / Number(t.invoices)) * 100) / 100 : 0,
      cogs: costs ? cogs : null,
      grossMargin: costs ? revenue - cogs : null,
      marginPct: costs && revenue > 0 ? Math.round(((revenue - cogs) / revenue) * 1000) / 10 : null,
      stockValue: costs ? stockValue : null,
      turnover: costs && stockValue > 0 ? Math.round((cogs / stockValue) * 100) / 100 : null,
    },
    best: products.slice(0, 10),
    lowest: [...products].sort((a, b) => a.qty - b.qty || a.revenue - b.revenue).slice(0, 10),
    turnover: costs ? [...products].filter((p) => p.turnover !== null).sort((a, b) => (b.cost ?? 0) - (a.cost ?? 0)).slice(0, 15) : [],
    byCategory: byCategory.map((r) => ({ id: r.id, nameEn: r.nameEn, nameAr: r.nameAr, qty: n(r.qty), revenue: n(r.revenue) })),
    byBrand: byBrand.map((r) => ({ id: r.id, name: r.name, qty: n(r.qty), revenue: n(r.revenue) })),
    monthly: monthly.map((r) => ({ month: r.month, qty: n(r.qty), revenue: n(r.revenue), invoices: Number(r.invoices) })),
    yearly: { year, thisYear: yearSeries(year), lastYear: yearSeries(year - 1) },
    noSales: { total: Number(noSales[0]?.total ?? 0), rows: noSales.map((r) => ({ id: r.id, sku: r.sku, nameEn: r.nameEn, nameAr: r.nameAr, unit: r.unit, onHand: n(r.onHand), value: costs ? n(r.value) : null })) },
    slowMoving: { total: Number(slow[0]?.total ?? 0), rows: slow.map((r) => ({ id: r.id, sku: r.sku, nameEn: r.nameEn, nameAr: r.nameAr, unit: r.unit, onHand: n(r.onHand), value: costs ? n(r.value) : null, lastSold: r.lastSold ? r.lastSold.toISOString().slice(0, 10) : null })) },
    lowStock: { total: Number(low[0]?.total ?? 0), rows: low.map((r) => ({ id: r.id, sku: r.sku, nameEn: r.nameEn, nameAr: r.nameAr, unit: r.unit, onHand: n(r.onHand), minStock: n(r.minStock) })) },
    valuation: costs ? valuation.map((w) => ({ id: w.id, code: w.code, nameEn: w.nameEn, nameAr: w.nameAr, value: n(w.value), qty: n(w.qty) })) : [],
  };
}
export type SalesAnalytics = Awaited<ReturnType<typeof salesAnalytics>>;
