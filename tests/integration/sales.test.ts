import { beforeEach, describe, expect, it } from "vitest";
import type { User } from "@prisma/client";
import { saveCategory, saveBrand, saveProduct } from "@/server/services/inventory-catalog";
import { addVariants } from "@/server/services/product-variants";
import { saveBin, saveWarehouse } from "@/server/services/inventory-warehouses";
import { createDocument } from "@/server/services/inventory-documents";
import { cancelSale, confirmSale, createSale, getSale, listSales, updateSale } from "@/server/services/sales";
import { salesAnalytics } from "@/server/services/sales-analytics";
import { ForbiddenError, ValidationError } from "@/server/errors";
import { DEFAULT_TIMEZONE } from "@/lib/constants";
import { addDaysToKey, todayKey } from "@/lib/time";
import { asCurrent, makeUser, prisma, resetDb } from "../helpers";

/** Sales invoices (draft, confirm = stock issue, cancel = reversal) and the analytics built on them. */
const day = todayKey(DEFAULT_TIMEZONE);
let admin: User, manager: User, sales: User, accountant: User, store: User, tech: User;
let main: string, van: string, binA: string;
let lock: string, cable: string, camera: string;
const as = (u: User) => asCurrent(u);
const qty = async (productId: string, warehouseId?: string) =>
  (await prisma.stockBalance.aggregate({ where: { productId, ...(warehouseId ? { warehouseId } : {}) }, _sum: { quantity: true } }))._sum.quantity?.toNumber() ?? 0;

beforeEach(async () => {
  await resetDb();
  admin = await makeUser("ADMIN");
  manager = await makeUser("WAREHOUSE_MANAGER");
  sales = await makeUser("SALES", { name: "Sara Sales" });
  accountant = await makeUser("ACCOUNTANT");
  store = await makeUser("STORE");
  tech = await makeUser("TECHNICIAN");
  const m = as(manager);
  main = (await saveWarehouse(m, null, { code: "MAIN", nameEn: "Main", nameAr: "الرئيسي", kind: "WAREHOUSE" })).id;
  binA = (await saveBin(m, main, null, { code: "A-01" })).id;
  van = (await saveWarehouse(m, null, { code: "VAN-1", nameEn: "Van", nameAr: "عربية", kind: "VEHICLE", technicianId: tech.id })).id;
  const locks = await saveCategory(m, null, { code: "LCK", nameEn: "Locks", nameAr: "أقفال" });
  const yale = await saveBrand(m, null, { name: "Yale" });
  lock = (await saveProduct(m, null, { sku: "LOCK", nameEn: "Lock", nameAr: "قفل", unitId: "unit-pcs", categoryId: locks.id, brandId: yale.id, purchaseCost: 1000, sellingPrice: 1500, serialMode: "REQUIRED", minStock: 5 })).id;
  cable = (await saveProduct(m, null, { sku: "CABLE", nameEn: "Cable", nameAr: "كابل", unitId: "unit-m", purchaseCost: 10, sellingPrice: 20 })).id;
  camera = (await saveProduct(m, null, { sku: "CAM", nameEn: "Camera", nameAr: "كاميرا", unitId: "unit-pcs", purchaseCost: 300, sellingPrice: 500 })).id;
  await createDocument(m, {
    type: "RECEIPT",
    toWarehouseId: main,
    documentDate: day,
    lines: [
      { productId: lock, quantity: 3, serials: ["L1", "L2", "L3"], toBinId: binA },
      { productId: cable, quantity: 100 },
      { productId: camera, quantity: 4, toBinId: binA },
    ],
  }, { post: true });
});

const saleBody = (lines: unknown[], extra: Record<string, unknown> = {}) => ({ invoiceDate: day, customerName: "Walk-in Ahmed", customerPhone: "01001234567", warehouseId: main, paymentMethod: "CASH", lines, ...extra });

describe("sales invoices", () => {
  it("computes totals exactly, confirms into a posted issue taken from the right bins and serials, and records the cost", async () => {
    const s = as(sales);
    const draft = await createSale(s, saleBody([
      { productId: lock, quantity: 1, unitPrice: 1500, discount: 100, serials: ["L2"] },
      { productId: cable, quantity: 12.5, unitPrice: 20.1 },
    ]));
    expect(draft.number).toMatch(/^INV-\d{4}-000001$/);
    // A draft moves no stock.
    expect(await qty(lock)).toBe(3);
    const before = await getSale(s, draft.id);
    expect(before).toMatchObject({ status: "DRAFT", subtotal: 1751.25, discountTotal: 100, total: 1651.25 });

    const confirmed = await confirmSale(s, draft.id);
    expect(confirmed.status).toBe("CONFIRMED");
    expect(await qty(lock)).toBe(2);
    expect(await qty(cable)).toBe(87.5);
    expect((await prisma.productSerial.findUniqueOrThrow({ where: { productId_serial: { productId: lock, serial: "L2" } } })).warehouseId).toBeNull();
    const doc = await prisma.stockDocument.findUniqueOrThrow({ where: { id: confirmed.stockDocument?.id ?? (await prisma.salesInvoice.findUniqueOrThrow({ where: { id: draft.id } })).stockDocumentId! }, include: { lines: true } });
    expect(doc).toMatchObject({ type: "ISSUE", status: "POSTED", reference: draft.number, counterparty: "Walk-in Ahmed" });
    expect(doc.lines.find((l) => l.productId === lock)!.fromBinId).toBe(binA);
    // The cost each line left at (moving average), for margins and turnover.
    const lines = await prisma.salesInvoiceLine.findMany({ where: { invoiceId: draft.id }, orderBy: { lineNo: "asc" } });
    expect(lines.map((l) => l.unitCost?.toNumber())).toEqual([1000, 10]);
    // Confirming twice is a no-op; a confirmed sale cannot be edited (service and database).
    await confirmSale(s, draft.id);
    expect(await qty(lock)).toBe(2);
    await expect(updateSale(s, draft.id, saleBody([{ productId: cable, quantity: 1, unitPrice: 1 }]))).rejects.toThrow(/Only a draft/);
    await expect(prisma.salesInvoice.update({ where: { id: draft.id }, data: { total: 1 } })).rejects.toThrow(/cannot be changed/);
    await expect(prisma.salesInvoiceLine.update({ where: { id: lines[0]!.id }, data: { unitPrice: 1 } })).rejects.toThrow(/cannot change/);
  });

  it("refuses a sale with more than the warehouse holds, naming the line, and nothing moves", async () => {
    const s = as(sales);
    const err = await createSale(s, saleBody([{ productId: camera, quantity: 5, unitPrice: 500 }]), { confirm: true }).catch((e) => e);
    expect(err).toBeInstanceOf(ValidationError);
    expect(err.fieldErrors["lines.0.quantity"]).toMatch(/Not enough/);
    expect(await qty(camera)).toBe(4);
    expect(await prisma.salesInvoice.count()).toBe(0);
  });

  it("validates lines: serial counts, discount larger than the line, a product with variants", async () => {
    const s = as(sales);
    await expect(createSale(s, saleBody([{ productId: lock, quantity: 2, unitPrice: 1500, serials: ["L1"] }]))).rejects.toMatchObject({ fieldErrors: { "lines.0.serials": expect.any(String) } });
    await expect(createSale(s, saleBody([{ productId: cable, quantity: 1, unitPrice: 10, discount: 11 }]))).rejects.toMatchObject({ fieldErrors: { "lines.0.discount": expect.any(String) } });
    const parent = await saveProduct(as(manager), null, { nameEn: "Panel", nameAr: "شاشة", unitId: "unit-pcs" });
    await addVariants(as(manager), parent.id, { variants: [{ variantNameEn: "White", variantNameAr: "أبيض" }] });
    await expect(createSale(s, saleBody([{ productId: parent.id, quantity: 1, unitPrice: 10 }]))).rejects.toMatchObject({ fieldErrors: { "lines.0.productId": expect.stringMatching(/choose the variant/i) } });
    await expect(createSale(s, saleBody([{ productId: cable, quantity: 1, unitPrice: 10 }], { customerName: "" }))).rejects.toMatchObject({ fieldErrors: { customerName: expect.any(String) } });
  });

  it("cancels a confirmed sale only with sales.void and a reason, reversing its stock", async () => {
    const r = await createSale(as(sales), saleBody([{ productId: lock, quantity: 1, unitPrice: 1500, serials: ["L1"] }]), { confirm: true });
    expect(await qty(lock)).toBe(2);
    await expect(cancelSale(as(sales), r.id, { reason: "Customer changed mind" })).rejects.toBeInstanceOf(ForbiddenError);
    await expect(cancelSale(as(accountant), r.id, {})).rejects.toMatchObject({ fieldErrors: { reason: expect.any(String) } });
    const c = await cancelSale(as(accountant), r.id, { reason: "Customer changed mind" });
    expect(c.status).toBe("CANCELLED");
    expect(await qty(lock)).toBe(3);
    const doc = await prisma.stockDocument.findFirstOrThrow({ where: { reference: r.number } });
    expect(doc).toMatchObject({ status: "CANCELLED", cancelReason: `${r.number}: Customer changed mind` });
    const audits = await prisma.auditLog.findMany({ where: { entityId: r.id }, orderBy: { createdAt: "asc" } });
    expect(audits.map((a) => a.action)).toEqual(["SALE_CREATED", "SALE_CONFIRMED", "SALE_CANCELLED"]);
  });

  it("is idempotent on retries and visible only to sales roles", async () => {
    const body = saleBody([{ productId: cable, quantity: 1, unitPrice: 20 }], { clientRequestId: "sale-request-0001" });
    const a = await createSale(as(sales), body);
    const b = await createSale(as(sales), body);
    expect(a.id).toBe(b.id);
    await expect(createSale(as(store), body)).rejects.toBeInstanceOf(ForbiddenError);
    await expect(listSales(as(tech))).rejects.toThrow();
    expect((await listSales(as(accountant))).total).toBe(1);
  });
});

describe("sales analytics", () => {
  it("counts confirmed sales only: transfers, technician issues, adjustments, drafts and cancelled sales are not sales", async () => {
    const m = as(manager);
    // Stock movements that are NOT sales.
    await createDocument(m, { type: "TRANSFER", fromWarehouseId: main, toWarehouseId: van, documentDate: day, lines: [{ productId: cable, quantity: 30 }] }, { post: true });
    await createDocument(m, { type: "ISSUE", fromWarehouseId: van, documentDate: day, reference: "APT-000001", lines: [{ productId: cable, quantity: 10 }] }, { post: true });
    await createDocument(m, { type: "ADJUSTMENT", toWarehouseId: main, documentDate: day, lines: [{ productId: camera, quantity: 1, direction: "DECREASE", reason: "Broken", fromBinId: binA }] }, { post: true });
    // A draft sale and a cancelled sale.
    await createSale(as(sales), saleBody([{ productId: cable, quantity: 5, unitPrice: 20 }]));
    const cancelled = await createSale(as(sales), saleBody([{ productId: camera, quantity: 1, unitPrice: 500 }]), { confirm: true });
    await cancelSale(as(admin), cancelled.id, { reason: "Test" });
    // The only real sales.
    await createSale(as(sales), saleBody([{ productId: cable, quantity: 2, unitPrice: 20 }, { productId: lock, quantity: 1, unitPrice: 1500, serials: ["L3"] }]), { confirm: true });
    await createSale(as(sales), saleBody([{ productId: cable, quantity: 3, unitPrice: 20 }]), { confirm: true });

    const a = await salesAnalytics(as(admin), {});
    expect(a.totals).toMatchObject({ revenue: 1600, qty: 6, invoices: 2, cogs: 1050, grossMargin: 550 });
    expect(a.best.map((p) => [p.sku, p.qty, p.revenue])).toEqual([["CABLE", 5, 100], ["LOCK", 1, 1500]]);
    expect(a.lowest[0]!.sku).toBe("LOCK");
    // Camera sold nothing (its only sale was cancelled, its adjustment is not a sale).
    expect(a.noSales.rows.map((r) => r.sku)).toEqual(["CAM"]);
    expect(a.byCategory.find((c) => c.nameEn === "Locks")!.revenue).toBe(1500);
    expect(a.byBrand.find((b) => b.name === "Yale")!.qty).toBe(1);
    expect(a.monthly).toEqual([{ month: day.slice(0, 7), qty: 6, revenue: 1600, invoices: 2 }]);
    expect(a.yearly.thisYear[Number(day.slice(5, 7)) - 1]).toBe(1600);
    // Lock: 2 left, minimum 5 → low stock.
    expect(a.lowStock.rows.map((r) => r.sku)).toEqual(["LOCK"]);
  });

  it("filters by category, brand, warehouse and product, rolls variants up, and hides costs from Sales", async () => {
    const m = as(manager);
    const p = await saveProduct(m, null, { sku: "SLX", nameEn: "Lock X", nameAr: "قفل X", unitId: "unit-pcs", purchaseCost: 100, sellingPrice: 200 });
    const { created } = await addVariants(m, p.id, { variants: [{ variantNameEn: "Black", variantNameAr: "أسود" }, { variantNameEn: "Gold", variantNameAr: "ذهبي" }] });
    await createDocument(m, { type: "RECEIPT", toWarehouseId: main, documentDate: day, lines: created.map((v) => ({ productId: v.id, quantity: 5 })) }, { post: true });
    await createSale(as(sales), saleBody(created.map((v) => ({ productId: v.id, quantity: 2, unitPrice: 200 }))), { confirm: true });
    await createSale(as(sales), saleBody([{ productId: cable, quantity: 1, unitPrice: 20 }]), { confirm: true });

    const rolled = await salesAnalytics(as(admin), { productId: p.id });
    expect(rolled.best.map((r) => [r.sku, r.qty])).toEqual([["SLX", 4]]);
    const split = await salesAnalytics(as(admin), { productId: p.id, rollUp: false });
    expect(split.best.map((r) => r.qty)).toEqual([2, 2]);
    expect((await salesAnalytics(as(admin), { warehouseId: van })).totals.revenue).toBe(0);
    const yale = await prisma.brand.findFirstOrThrow({ where: { name: "Yale" } });
    expect((await salesAnalytics(as(admin), { brandId: yale.id })).totals.revenue).toBe(0);
    const old = await salesAnalytics(as(admin), { from: addDaysToKey(day, -400), to: addDaysToKey(day, -365) });
    expect(old.totals.invoices).toBe(0);

    const salesView = await salesAnalytics(as(sales), {});
    expect(salesView.totals.cogs).toBeNull();
    expect(salesView.best[0]!.cost).toBeNull();
    expect(salesView.valuation).toEqual([]);
    await expect(salesAnalytics(as(store), {})).rejects.toBeInstanceOf(ForbiddenError);
  });
});
