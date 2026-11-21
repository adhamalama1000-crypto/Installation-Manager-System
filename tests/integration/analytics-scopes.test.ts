/**
 * Sales analytics follows the reader's sales and inventory scopes (audit L8): sales figures only
 * count invoices inside the sales scope, stock figures only warehouses the reader may see. Readers
 * with ALL scopes keep seeing everything.
 */
import { beforeEach, describe, expect, it } from "vitest";
import type { User } from "@prisma/client";
import { saveProduct } from "@/server/services/inventory-catalog";
import { saveWarehouse } from "@/server/services/inventory-warehouses";
import { createDocument } from "@/server/services/inventory-documents";
import { createSale } from "@/server/services/sales";
import { salesAnalytics } from "@/server/services/sales-analytics";
import { DEFAULT_TIMEZONE } from "@/lib/constants";
import { todayKey } from "@/lib/time";
import { asCurrent, makeUser, prisma, resetDb } from "../helpers";

const day = todayKey(DEFAULT_TIMEZONE);
const SETTINGS = { salesCanViewReports: true };
let admin: User, manager: User, salesA: User, salesB: User, salesC: User, nobody: User, tech: User;
let main: string, van: string, cable: string, plug: string;

async function withAccess(u: User, data: { dataScopes?: Record<string, string>; permissionGrants?: string[] }) {
  return asCurrent(await prisma.user.update({ where: { id: u.id }, data }), SETTINGS);
}

beforeEach(async () => {
  await resetDb();
  const team = await prisma.team.create({ data: { name: "North" } });
  admin = await makeUser("ADMIN");
  manager = await makeUser("WAREHOUSE_MANAGER");
  salesA = await makeUser("SALES", { name: "Sales A" });
  salesB = await makeUser("SALES", { name: "Sales B" });
  salesC = await makeUser("SALES", { name: "Sales C" });
  nobody = await makeUser("SALES", { name: "Sales None" });
  tech = await makeUser("TECHNICIAN");
  await prisma.user.updateMany({ where: { id: { in: [salesA.id, salesB.id] } }, data: { teamId: team.id } });
  [salesA, salesB] = await Promise.all([salesA, salesB].map((u) => prisma.user.findUniqueOrThrow({ where: { id: u.id } })));
  const m = asCurrent(manager);
  main = (await saveWarehouse(m, null, { code: "MAIN", nameEn: "Main", nameAr: "الرئيسي", kind: "WAREHOUSE" })).id;
  van = (await saveWarehouse(m, null, { code: "VAN-1", nameEn: "Van", nameAr: "عربية", kind: "VEHICLE", technicianId: tech.id })).id;
  cable = (await saveProduct(m, null, { sku: "CABLE", nameEn: "Cable", nameAr: "كابل", unitId: "unit-m", purchaseCost: 10, sellingPrice: 20 })).id;
  plug = (await saveProduct(m, null, { sku: "PLUG", nameEn: "Plug", nameAr: "فيشة", unitId: "unit-pcs", purchaseCost: 5, sellingPrice: 15, minStock: 50 })).id;
  await createDocument(m, { type: "RECEIPT", toWarehouseId: main, documentDate: day, lines: [{ productId: cable, quantity: 100 }, { productId: plug, quantity: 20 }] }, { post: true });
  await createDocument(m, { type: "RECEIPT", toWarehouseId: van, documentDate: day, lines: [{ productId: cable, quantity: 7 }] }, { post: true });
  const sell = (u: User, lines: unknown[]) =>
    createSale(asCurrent(u, SETTINGS), { invoiceDate: day, customerName: "Walk-in", customerPhone: "01001234567", warehouseId: main, paymentMethod: "CASH", lines }, { confirm: true });
  await sell(salesA, [{ productId: cable, quantity: 1, unitPrice: 20 }]); // 20
  await sell(salesB, [{ productId: plug, quantity: 2, unitPrice: 15 }]); // 30
  await sell(salesC, [{ productId: cable, quantity: 5, unitPrice: 20 }]); // 100
});

const salesFigures = (a: Awaited<ReturnType<typeof salesAnalytics>>) => ({
  revenue: a.totals.revenue,
  invoices: a.totals.invoices,
  qty: a.totals.qty,
  best: a.best.map((p) => [p.sku, p.qty]),
  monthly: a.monthly.map((r) => r.revenue),
  thisYear: a.yearly.thisYear.reduce((s, v) => s + v, 0),
  byCategory: a.byCategory.reduce((s, c) => s + c.revenue, 0),
  byBrand: a.byBrand.reduce((s, b) => s + b.revenue, 0),
});

describe("sales scope", () => {
  it("ALL: every invoice (admin and an ALL-scoped Sales user)", async () => {
    expect(salesFigures(await salesAnalytics(asCurrent(admin), {}))).toEqual({ revenue: 150, invoices: 3, qty: 8, best: [["CABLE", 6], ["PLUG", 2]], monthly: [150], thisYear: 150, byCategory: 150, byBrand: 150 });
    expect(salesFigures(await salesAnalytics(asCurrent(salesC, SETTINGS), {})).revenue).toBe(150);
  });

  it("TEAM: only the team's invoices, in totals, rankings, trends and breakdowns", async () => {
    const team = await withAccess(salesA, { dataScopes: { sales: "TEAM" } });
    expect(salesFigures(await salesAnalytics(team, {}))).toEqual({ revenue: 50, invoices: 2, qty: 3, best: [["PLUG", 2], ["CABLE", 1]], monthly: [50], thisYear: 50, byCategory: 50, byBrand: 50 });
  });

  it("OWN: only the reader's own invoices", async () => {
    const own = await withAccess(salesA, { dataScopes: { sales: "OWN" } });
    const a = await salesAnalytics(own, {});
    expect(salesFigures(a)).toEqual({ revenue: 20, invoices: 1, qty: 1, best: [["CABLE", 1]], monthly: [20], thisYear: 20, byCategory: 20, byBrand: 20 });
    // Plug was sold, but not by Sales A: for this reader it sold nothing.
    expect(a.noSales.rows.map((r) => r.sku)).toEqual(["PLUG"]);
  });

  it("no authorised invoices: zero everywhere, whatever the filters", async () => {
    const none = await withAccess(nobody, { dataScopes: { sales: "OWN" } });
    for (const f of [{}, { warehouseId: main }, { productId: cable }, { from: "2000-01-01" }]) {
      expect(salesFigures(await salesAnalytics(none, f))).toEqual({ revenue: 0, invoices: 0, qty: 0, best: [], monthly: [], thisYear: 0, byCategory: 0, byBrand: 0 });
    }
  });
});

describe("inventory scope", () => {
  it("ALL: stock in every warehouse, low stock and valuation (admin)", async () => {
    const a = await salesAnalytics(asCurrent(admin), {});
    expect(a.best.find((p) => p.sku === "CABLE")!.onHand).toBe(101); // 100 - 6 sold + 7 in the van
    expect(a.lowStock.rows.map((r) => r.sku)).toEqual(["PLUG"]);
    expect(a.valuation.map((w) => w.code).sort()).toEqual(["MAIN", "VAN-1"]);
    expect(a.totals.stockValue).toBe(94 * 10 + 18 * 5 + 7 * 10);
  });

  it("ASSIGNED (a technician given analytics): only their own vehicle's stock, no company low-stock list", async () => {
    const t = await withAccess(tech, { permissionGrants: ["analytics.view", "inventory.reports"] });
    const a = await salesAnalytics(t, {});
    expect(a.best.find((p) => p.sku === "CABLE")!.onHand).toBe(7);
    expect(a.best.find((p) => p.sku === "PLUG")!.onHand).toBe(0);
    expect(a.lowStock.rows).toEqual([]);
    expect(a.showCosts).toBe(true); // inventory.reports shows costs, so the valuation is really listed
    expect(a.valuation.map((w) => w.code)).toEqual(["VAN-1"]);
    expect(a.totals.stockValue).toBe(7 * 10);
    // Asking for the main warehouse shows none of its stock.
    const mainOnly = await salesAnalytics(t, { warehouseId: main });
    expect(mainOnly.valuation).toEqual([]);
    expect(mainOnly.noSales.rows.every((r) => r.onHand === 0)).toBe(true);
  });

  it("no inventory access (Sales): no stock figures at all, like the product catalogue", async () => {
    const a = await salesAnalytics(asCurrent(salesC, SETTINGS), {});
    expect(a.best.every((p) => p.onHand === 0)).toBe(true);
    expect(a.lowStock.rows).toEqual([]);
    expect(a.slowMoving.rows).toEqual([]);
    expect(a.valuation).toEqual([]);
  });

  it("unauthorised records cannot move the aggregates: a big sale outside the scope changes nothing", async () => {
    const own = await withAccess(salesA, { dataScopes: { sales: "OWN" } });
    const before = salesFigures(await salesAnalytics(own, {}));
    await createSale(asCurrent(salesC, SETTINGS), { invoiceDate: day, customerName: "Walk-in", customerPhone: "01001234567", warehouseId: main, paymentMethod: "CASH", lines: [{ productId: cable, quantity: 50, unitPrice: 999 }] }, { confirm: true });
    expect(salesFigures(await salesAnalytics(own, {}))).toEqual(before);
    expect((await salesAnalytics(asCurrent(admin), {})).totals.revenue).toBe(150 + 50 * 999);
  });
});
