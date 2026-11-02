import { beforeEach, describe, expect, it } from "vitest";
import type { User } from "@prisma/client";
import { getProduct, listProducts, saveBrand, saveCategory, saveProduct, saveUnit } from "@/server/services/inventory-catalog";
import { getWarehouse, listWarehouses, saveBin, saveWarehouse } from "@/server/services/inventory-warehouses";
import { cancelDocument, createDocument, getDocument, listDocuments, postDocument, updateDocument } from "@/server/services/inventory-documents";
import { exportLedgerCsv, listBalances, listMovements } from "@/server/services/inventory-stock";
import { ForbiddenError, NotFoundError, StaleRecordError, ValidationError } from "@/server/errors";
import { DEFAULT_TIMEZONE } from "@/lib/constants";
import { todayKey, addDaysToKey } from "@/lib/time";
import { asCurrent, makeUser, prisma, resetDb } from "../helpers";

/**
 * ERP inventory foundation: catalogue, warehouses, the posting engine (receipts, issues,
 * transfers, returns, adjustments, reversals), immutability and the access rules.
 */
const day = todayKey(DEFAULT_TIMEZONE);

let manager: User, store: User, tech: User, otherTech: User, sales: User, accountant: User, viewer: User;
let main: string, side: string, van: string;
let lock: string, cable: string;

beforeEach(async () => {
  await resetDb();
  manager = await makeUser("WAREHOUSE_MANAGER", { name: "Wael Manager" });
  store = await makeUser("STORE", { name: "Samy Store" });
  tech = await makeUser("TECHNICIAN", { name: "Karim Tech" });
  otherTech = await makeUser("TECHNICIAN", { name: "Hany Tech" });
  sales = await makeUser("SALES");
  accountant = await makeUser("ACCOUNTANT");
  viewer = await makeUser("VIEWER", { viewerPermissions: ["appointments.view"] });
  const m = asCurrent(manager);
  main = (await saveWarehouse(m, null, { code: "main", nameEn: "Main store", nameAr: "المخزن الرئيسي", kind: "WAREHOUSE" })).id;
  side = (await saveWarehouse(m, null, { code: "SIDE", nameEn: "Branch store", nameAr: "مخزن الفرع", kind: "WAREHOUSE" })).id;
  van = (await saveWarehouse(m, null, { code: "VAN-KARIM", nameEn: "Karim's van", nameAr: "عربية كريم", kind: "VEHICLE", technicianId: tech.id })).id;
  lock = (await saveProduct(m, null, { sku: "lk-100", nameEn: "Smart lock K100", nameAr: "قفل ذكي K100", unitId: "unit-pcs", purchaseCost: 1000, sellingPrice: 1500, trackSerials: true, minStock: 2 })).id;
  cable = (await saveProduct(m, null, { sku: "CBL-2", nameEn: "Cable 2 core", nameAr: "سلك 2 خط", unitId: "unit-m", purchaseCost: 10 })).id;
});

const as = (u: User) => asCurrent(u);
const line = (productId: string, quantity: number | string, extra: Record<string, unknown> = {}) => ({ productId, quantity, ...extra });
const receipt = (lines: unknown[], extra: Record<string, unknown> = {}) => ({ type: "RECEIPT", toWarehouseId: main, documentDate: day, counterparty: "Supplier A", lines, ...extra });
const issue = (lines: unknown[], from = main, extra: Record<string, unknown> = {}) => ({ type: "ISSUE", fromWarehouseId: from, documentDate: day, lines, ...extra });

async function qty(productId: string, warehouseId: string, binId: string | null = null) {
  const b = await prisma.stockBalance.findUnique({ where: { productId_warehouseId_binKey: { productId, warehouseId, binKey: binId ?? "" } } });
  return b ? b.quantity.toNumber() : 0;
}
async function avgCost(productId: string) {
  return (await prisma.product.findUniqueOrThrow({ where: { id: productId } })).averageCost.toNumber();
}
async function serialAt(serial: string) {
  return (await prisma.productSerial.findUniqueOrThrow({ where: { productId_serial: { productId: lock, serial } } })).warehouseId;
}
const post = (u: User, body: Record<string, unknown>) => createDocument(as(u), body, { post: true });

describe("product catalogue", () => {
  it("normalises the SKU, requires both names, and keeps SKU and barcode unique", async () => {
    const m = as(manager);
    const p = await getProduct(m, lock);
    expect(p.sku).toBe("LK-100");
    expect(p.unit.code).toBe("PCS");

    const missing = await saveProduct(m, null, { sku: "X-1", nameEn: "", nameAr: "", unitId: "unit-pcs" }).catch((e) => e);
    expect(missing).toBeInstanceOf(ValidationError);
    expect(Object.keys(missing.fieldErrors)).toEqual(expect.arrayContaining(["nameEn", "nameAr"]));
    await expect(saveProduct(m, null, { sku: "bad sku!", nameEn: "A", nameAr: "ب", unitId: "unit-pcs" })).rejects.toMatchObject({ fieldErrors: { sku: expect.any(String) } });

    const dup = await saveProduct(m, null, { sku: " lk-100 ", nameEn: "Other", nameAr: "آخر", unitId: "unit-pcs" }).catch((e) => e);
    expect(dup.fieldErrors.sku).toMatch(/already used/i);

    await saveProduct(m, null, { sku: "HUB-1", barcode: "6221234567890", nameEn: "Hub", nameAr: "هاب", unitId: "unit-pcs" });
    const dupBarcode = await saveProduct(m, null, { sku: "HUB-2", barcode: "6221234567890", nameEn: "Hub 2", nameAr: "هاب 2", unitId: "unit-pcs" }).catch((e) => e);
    expect(dupBarcode.fieldErrors.barcode).toMatch(/already used/i);
    // Products without a barcode do not collide with each other.
    await saveProduct(m, null, { sku: "HUB-3", nameEn: "Hub 3", nameAr: "هاب 3", unitId: "unit-pcs" });
    await saveProduct(m, null, { sku: "HUB-4", nameEn: "Hub 4", nameAr: "هاب 4", unitId: "unit-pcs" });
  });

  it("refuses fractional minimums for whole units, serial tracking on fractional units, and stale edits", async () => {
    const m = as(manager);
    await expect(saveProduct(m, null, { sku: "S-1", nameEn: "Screw", nameAr: "مسمار", unitId: "unit-pcs", minStock: 1.5 })).rejects.toMatchObject({ fieldErrors: { minStock: expect.any(String) } });
    await expect(saveProduct(m, null, { sku: "S-2", nameEn: "Wire", nameAr: "سلك", unitId: "unit-m", trackSerials: true })).rejects.toMatchObject({ fieldErrors: { trackSerials: expect.any(String) } });
    const p = await getProduct(m, cable);
    await saveProduct(m, cable, { ...base(p), nameEn: "Cable 2x1.5", version: p.version });
    await expect(saveProduct(m, cable, { ...base(p), nameEn: "Again", version: p.version })).rejects.toBeInstanceOf(StaleRecordError);
  });

  it("fixes the unit and serial tracking once stock has moved", async () => {
    const m = as(manager);
    await post(manager, receipt([line(cable, 5)]));
    const p = await getProduct(m, cable);
    const e = await saveProduct(m, cable, { ...base(p), unitId: "unit-roll", version: p.version }).catch((x) => x);
    expect(e.fieldErrors.unitId).toMatch(/cannot change/i);
    // The database refuses it too.
    await expect(prisma.product.update({ where: { id: cable }, data: { unitId: "unit-roll" } })).rejects.toThrow(/cannot change/);
    await expect(prisma.product.delete({ where: { id: cable } })).rejects.toThrow(/cannot be deleted/);
  });

  it("searches by SKU, barcode and either name, filters by category including subcategories, and paginates", async () => {
    const m = as(manager);
    const locks = await saveCategory(m, null, { nameEn: "Locks", nameAr: "أقفال" });
    const smart = await saveCategory(m, null, { nameEn: "Smart locks", nameAr: "أقفال ذكية", parentId: locks.id });
    await expect(saveCategory(m, null, { nameEn: "Too deep", nameAr: "عميق", parentId: smart.id })).rejects.toBeInstanceOf(ValidationError);
    await expect(saveCategory(m, null, { nameEn: "locks", nameAr: "أقفال تانية" })).rejects.toBeInstanceOf(ValidationError);
    const brand = await saveBrand(m, null, { name: "Aqara" });
    await expect(saveBrand(m, null, { name: "AQARA" })).rejects.toBeInstanceOf(ValidationError);
    for (let i = 0; i < 30; i++) {
      await saveProduct(m, null, { sku: `P-${String(i).padStart(2, "0")}`, nameEn: `Part ${i}`, nameAr: `قطعة ${i}`, unitId: "unit-pcs", categoryId: i % 2 ? smart.id : null, brandId: brand.id });
    }
    const page1 = await listProducts(m, { q: "part", sort: "sku", page: 1 });
    expect(page1.total).toBe(30);
    expect(page1.rows).toHaveLength(25);
    expect((await listProducts(m, { q: "part", sort: "sku", page: 2 })).rows).toHaveLength(5);
    expect((await listProducts(m, { categoryId: locks.id })).total).toBe(15);
    expect((await listProducts(m, { q: "قفل" })).rows.map((r) => r.sku)).toEqual(["LK-100"]);
    expect((await listProducts(m, { q: "lk-1" })).rows.map((r) => r.sku)).toEqual(["LK-100"]);
  });

  it("deactivates a product only once its stock is gone, and still shows stock of an inactive product", async () => {
    const m = as(manager);
    await post(store, receipt([line(cable, 4)]));
    const p = await getProduct(m, cable);
    const e = await saveProduct(m, cable, { ...base(p), isActive: false, version: p.version }).catch((x) => x);
    expect(e).toBeInstanceOf(ValidationError);
    expect(e.fieldErrors.isActive).toMatch(/still has stock/);
    // Stock that is already there (e.g. from before this rule) stays visible and counted.
    await prisma.product.update({ where: { id: cable }, data: { isActive: false } });
    const rows = (await listBalances(m, {})).rows.map((r) => [r.sku, r.quantity]);
    expect(rows).toContainEqual(["CBL-2", 4]);
    await prisma.product.update({ where: { id: cable }, data: { isActive: true } });
    await post(store, issue([line(cable, 4)]));
    const after = await getProduct(m, cable);
    await saveProduct(m, cable, { ...base(after), isActive: false, version: after.version });
    expect((await getProduct(m, cable)).isActive).toBe(false);
  });

  it("adds units of measure beyond the built-in ones", async () => {
    const code = `KG${Date.now() % 100000}`;
    const kg = await saveUnit(as(manager), null, { code: code.toLowerCase(), nameEn: "Kilogram", nameAr: "كيلو", allowsFraction: true });
    expect(kg.code).toBe(code);
    await expect(saveUnit(as(manager), null, { code, nameEn: "Kilo", nameAr: "كيلو" })).rejects.toBeInstanceOf(ValidationError);
    await expect(saveUnit(as(store), null, { code: "X", nameEn: "X", nameAr: "س" })).rejects.toBeInstanceOf(ForbiddenError);
    await prisma.unit.delete({ where: { id: kg.id } });
  });
});

function base(p: Awaited<ReturnType<typeof getProduct>>) {
  return { sku: p.sku, nameEn: p.nameEn, nameAr: p.nameAr, unitId: p.unit.id, purchaseCost: p.purchaseCost, minStock: p.minStock, trackSerials: p.trackSerials };
}

describe("warehouses and vehicles", () => {
  it("creates warehouses with unique codes and links a vehicle to one technician", async () => {
    const m = as(manager);
    expect((await getWarehouse(m, main)).code).toBe("MAIN");
    await expect(saveWarehouse(m, null, { code: "Main", nameEn: "Dup", nameAr: "مكرر", kind: "WAREHOUSE" })).rejects.toMatchObject({ fieldErrors: { code: expect.any(String) } });
    await expect(saveWarehouse(m, null, { code: "VAN-2", nameEn: "Van", nameAr: "عربية", kind: "VEHICLE" })).rejects.toMatchObject({ fieldErrors: { technicianId: expect.any(String) } });
    await expect(saveWarehouse(m, null, { code: "VAN-3", nameEn: "Van", nameAr: "عربية", kind: "VEHICLE", technicianId: tech.id })).rejects.toMatchObject({ fieldErrors: { technicianId: expect.any(String) } });
    await expect(saveWarehouse(m, null, { code: "VAN-4", nameEn: "Van", nameAr: "عربية", kind: "VEHICLE", technicianId: sales.id })).rejects.toMatchObject({ fieldErrors: { technicianId: expect.any(String) } });
    await expect(saveWarehouse(as(store), null, { code: "X", nameEn: "X", nameAr: "س", kind: "WAREHOUSE" })).rejects.toBeInstanceOf(ForbiddenError);
    // No vehicle is created automatically for the other technician.
    expect(await prisma.warehouse.count({ where: { technicianId: otherTech.id } })).toBe(0);
  });

  it("adds bins with unique codes and refuses to deactivate a bin or warehouse that still holds stock", async () => {
    const m = as(manager);
    const bin = await saveBin(m, main, null, { code: "a-01", name: "Shelf A1" });
    expect(bin.code).toBe("A-01");
    await expect(saveBin(m, main, null, { code: "A-01" })).rejects.toBeInstanceOf(ValidationError);
    await post(manager, receipt([line(cable, 10, { toBinId: bin.id })]));
    await expect(saveBin(m, main, bin.id, { code: "A-01", isActive: false })).rejects.toMatchObject({ fieldErrors: { isActive: expect.any(String) } });
    const w = await getWarehouse(m, main);
    await expect(saveWarehouse(m, main, { code: "MAIN", nameEn: w.nameEn, nameAr: w.nameAr, kind: "WAREHOUSE", isActive: false, version: w.version })).rejects.toMatchObject({ fieldErrors: { isActive: expect.any(String) } });
  });
});

describe("posting stock documents", () => {
  it("receives goods: balances, ledger, moving average cost, serial locations and audit", async () => {
    const r1 = await post(store, receipt([line(lock, 2, { unitCost: 1000, serials: "SN-1\nSN-2" }), line(cable, 100)], { reference: "INV-77" }));
    expect(r1.number).toMatch(/^GRN-\d{4}-000001$/);
    expect(await qty(lock, main)).toBe(2);
    expect(await qty(cable, main)).toBe(100);
    expect(await avgCost(cable)).toBe(10); // the product's purchase cost when the line has none
    await post(store, receipt([line(lock, 2, { unitCost: 1300, serials: ["SN-3", "SN-4"] })]));
    expect(await avgCost(lock)).toBe(1150);
    expect(await serialAt("SN-3")).toBe(main);

    const doc = await getDocument(as(manager), r1.id);
    expect(doc.status).toBe("POSTED");
    expect(doc.movements.map((m) => [m.type, m.quantity, m.balanceAfter])).toEqual([
      ["GOODS_RECEIPT", 2, 2],
      ["GOODS_RECEIPT", 100, 100],
    ]);
    const audit = await prisma.auditLog.findMany({ where: { entityId: r1.id }, orderBy: { createdAt: "asc" } });
    expect(audit.map((a) => a.action)).toEqual(["STOCK_DOC_CREATED", "STOCK_DOC_POSTED"]);
  });

  it("issues stock and never lets it go negative unless the warehouse allows it", async () => {
    await post(store, receipt([line(cable, 10)]));
    await post(store, issue([line(cable, 4)], main, { reference: "APT-000123" }));
    expect(await qty(cable, main)).toBe(6);

    const short = await post(store, issue([line(cable, 7)])).catch((e) => e);
    expect(short).toBeInstanceOf(ValidationError);
    expect(short.message).toMatch(/Not enough CBL-2 Cable 2 core at MAIN: 6 available, 7 needed/);
    expect(short.fieldErrors["lines.0.quantity"]).toBeTruthy();
    expect(await qty(cable, main)).toBe(6);
    // Nothing of the refused posting stayed behind (the draft was rolled back with it).
    expect(await prisma.stockDocument.count({ where: { type: "ISSUE" } })).toBe(1);

    // The database itself refuses a negative balance.
    await expect(prisma.$executeRaw`UPDATE stock_balances SET quantity = -1 WHERE "productId" = ${cable}`).rejects.toThrow(/negative stock is not allowed/);

    // A warehouse whose policy allows it can go below zero (not for serial-tracked products).
    const m = as(manager);
    const w = await getWarehouse(m, side);
    await saveWarehouse(m, side, { code: "SIDE", nameEn: w.nameEn, nameAr: w.nameAr, kind: "WAREHOUSE", allowNegative: true, version: w.version });
    await post(store, issue([line(cable, 3)], side));
    expect(await qty(cable, side)).toBe(-3);
    await expect(post(store, issue([line(lock, 1, { serials: "SN-X" })], side))).rejects.toBeInstanceOf(ValidationError);
  });

  it("checks quantities against the unit: whole pieces, meters with decimals", async () => {
    await expect(post(store, receipt([line(lock, 1.5, { unitCost: 1000, serials: "A" })]))).rejects.toMatchObject({ fieldErrors: { "lines.0.quantity": expect.any(String) } });
    await post(store, receipt([line(cable, "12.5")]));
    await post(store, issue([line(cable, 2.25)]));
    expect(await qty(cable, main)).toBe(10.25);
  });

  it("transfers between warehouses and between bins of one warehouse, moving serials along", async () => {
    const bin = await saveBin(as(manager), main, null, { code: "B-1" });
    await post(store, receipt([line(lock, 2, { serials: "SN-1, SN-2" }), line(cable, 50)]));
    const t = await post(store, { type: "TRANSFER", fromWarehouseId: main, toWarehouseId: van, documentDate: day, lines: [line(lock, 1, { serials: "SN-2" }), line(cable, 20)] });
    expect(t.number).toMatch(/^TRF-/);
    expect([await qty(lock, main), await qty(lock, van), await qty(cable, main), await qty(cable, van)]).toEqual([1, 1, 30, 20]);
    expect(await serialAt("SN-2")).toBe(van);
    // A serial that is not in the source warehouse cannot be transferred from it.
    await expect(post(store, { type: "TRANSFER", fromWarehouseId: main, toWarehouseId: side, documentDate: day, lines: [line(lock, 1, { serials: "SN-2" })] })).rejects.toThrow(/Not at MAIN/);
    // Bin to bin inside the same warehouse.
    await post(store, { type: "TRANSFER", fromWarehouseId: main, toWarehouseId: main, documentDate: day, lines: [line(cable, 5, { toBinId: bin.id })] });
    expect([await qty(cable, main), await qty(cable, main, bin.id)]).toEqual([25, 5]);
    await expect(post(store, { type: "TRANSFER", fromWarehouseId: main, toWarehouseId: main, documentDate: day, lines: [line(cable, 5)] })).rejects.toBeInstanceOf(ValidationError);
    // Transfers do not change the average cost.
    expect(await avgCost(cable)).toBe(10);
  });

  it("handles customer returns (in) and supplier returns (out)", async () => {
    await post(store, receipt([line(lock, 1, { serials: "SN-1" })]));
    await post(store, issue([line(lock, 1, { serials: "SN-1" })]));
    expect(await serialAt("SN-1")).toBeNull();
    const cr = await post(store, { type: "RETURN", returnKind: "CUSTOMER", toWarehouseId: main, documentDate: day, counterparty: "Mr. Adel", lines: [line(lock, 1, { serials: "SN-1" })] });
    expect(cr.number).toMatch(/^RTN-/);
    expect(await serialAt("SN-1")).toBe(main);
    await post(store, { type: "RETURN", returnKind: "SUPPLIER", fromWarehouseId: main, documentDate: day, lines: [line(lock, 1, { serials: "SN-1" })] });
    expect(await qty(lock, main)).toBe(0);
    const movements = await prisma.inventoryMovement.findMany({ where: { productId: lock }, orderBy: { createdAt: "asc" }, select: { type: true } });
    expect(movements.map((m) => m.type)).toEqual(["GOODS_RECEIPT", "ISSUE", "CUSTOMER_RETURN", "SUPPLIER_RETURN"]);
  });

  it("lets the store prepare an adjustment but only an approver post it", async () => {
    await post(store, receipt([line(cable, 10)]));
    const draft = await createDocument(as(store), { type: "ADJUSTMENT", toWarehouseId: main, documentDate: day, lines: [line(cable, 2, { direction: "DECREASE", reason: "Damaged" }), line(cable, 0.5, { direction: "INCREASE", reason: "Found offcut" })] });
    await expect(postDocument(as(store), draft.id)).rejects.toBeInstanceOf(ForbiddenError);
    await expect(createDocument(as(store), { type: "ADJUSTMENT", toWarehouseId: main, documentDate: day, lines: [line(cable, 1, { direction: "DECREASE" })] })).rejects.toMatchObject({
      fieldErrors: { "lines.0.reason": expect.any(String) },
    });
    const posted = await postDocument(as(manager), draft.id);
    expect(posted.movements.map((m) => m.type)).toEqual(["ADJUSTMENT_DECREASE", "ADJUSTMENT_INCREASE"]);
    expect(await qty(cable, main)).toBe(8.5);
    // Opening balances need the approval permission too.
    await expect(createDocument(as(store), { type: "OPENING", toWarehouseId: side, documentDate: day, lines: [line(cable, 1)] })).rejects.toBeInstanceOf(ForbiddenError);
    expect((await post(manager, { type: "OPENING", toWarehouseId: side, documentDate: day, lines: [line(cable, 1, { unitCost: 12 })] })).number).toMatch(/^OB-/);
  });

  it("edits a draft until it is posted, and refuses a future date or a stale edit", async () => {
    const d = await createDocument(as(store), receipt([line(cable, 1)]));
    const draft = await getDocument(as(store), d.id);
    await updateDocument(as(store), d.id, { ...receipt([line(cable, 3)]), version: draft.version });
    await expect(updateDocument(as(store), d.id, { ...receipt([line(cable, 4)]), version: draft.version })).rejects.toBeInstanceOf(StaleRecordError);
    await expect(createDocument(as(store), receipt([line(cable, 1)], { documentDate: addDaysToKey(day, 2) }))).rejects.toMatchObject({ fieldErrors: { documentDate: expect.any(String) } });
    await postDocument(as(store), d.id);
    expect(await qty(cable, main)).toBe(3);
    await expect(updateDocument(as(store), d.id, receipt([line(cable, 9)]))).rejects.toThrow(/no longer a draft/);
    // Even directly in the database a posted document cannot change, and nothing is deleted.
    await expect(prisma.stockDocument.update({ where: { id: d.id }, data: { reference: "changed" } })).rejects.toThrow(/cannot be changed/);
    await expect(prisma.stockDocumentLine.updateMany({ where: { documentId: d.id }, data: { quantity: 9 } })).rejects.toThrow(/cannot change/);
    await expect(prisma.stockDocument.delete({ where: { id: d.id } })).rejects.toThrow(/cannot be deleted/);
  });
});

describe("the ledger is immutable; mistakes are reversed", () => {
  it("refuses to update or delete a movement", async () => {
    await post(store, receipt([line(cable, 5)]));
    const m = await prisma.inventoryMovement.findFirstOrThrow();
    await expect(prisma.inventoryMovement.update({ where: { id: m.id }, data: { quantity: 50 } })).rejects.toThrow(/append-only/);
    await expect(prisma.inventoryMovement.delete({ where: { id: m.id } })).rejects.toThrow(/append-only/);
  });

  it("cancels a posted document with reversal movements, restoring balances, serials and average cost", async () => {
    await post(store, receipt([line(cable, 10, { unitCost: 10 })]));
    const r = await post(store, receipt([line(cable, 10, { unitCost: 20 }), line(lock, 1, { serials: "SN-9" })]));
    expect(await avgCost(cable)).toBe(15);
    await expect(cancelDocument(as(store), r.id, { reason: "Wrong supplier" })).rejects.toBeInstanceOf(ForbiddenError);
    await expect(cancelDocument(as(manager), r.id, { reason: "" })).rejects.toMatchObject({ fieldErrors: { reason: expect.any(String) } });
    const c = await cancelDocument(as(manager), r.id, { reason: "Wrong supplier" });
    expect(c.status).toBe("CANCELLED");
    expect(c.cancelReason).toBe("Wrong supplier");
    expect(await qty(cable, main)).toBe(10);
    expect(await avgCost(cable)).toBe(10);
    expect(await serialAt("SN-9")).toBeNull();
    const reversals = c.movements.filter((m) => m.type === "REVERSAL");
    expect(reversals).toHaveLength(2);
    expect(reversals.every((m) => m.reversesId)).toBe(true);
    // The original movements are still there, unchanged.
    expect(c.movements.filter((m) => m.type === "GOODS_RECEIPT").map((m) => m.quantity)).toEqual([10, 1]);
    // Cancelling again changes nothing.
    await cancelDocument(as(manager), r.id, { reason: "again" });
    expect(await prisma.inventoryMovement.count({ where: { documentId: r.id } })).toBe(4);
  });

  it("refuses to reverse a receipt whose stock has already been issued", async () => {
    const r = await post(store, receipt([line(cable, 10)]));
    await post(store, issue([line(cable, 8)]));
    const e = await cancelDocument(as(manager), r.id, { reason: "mistake" }).catch((x) => x);
    expect(e).toBeInstanceOf(ValidationError);
    expect(e.message).toMatch(/cannot be cancelled/i);
    expect(e.fieldErrors._form).toMatch(/Not enough/);
    expect(await qty(cable, main)).toBe(2);
  });

  it("lists the movements of a posting in the order they were written", async () => {
    await post(store, receipt([line(lock, 1, { serials: "SN-7" }), line(cable, 10)]));
    const t = await post(store, { type: "TRANSFER", fromWarehouseId: main, toWarehouseId: van, documentDate: day, lines: [line(lock, 1, { serials: "SN-7" }), line(cable, 4)] });
    // Every movement of one posting has the same timestamp; the order still follows the lines,
    // each transfer line going out before it comes in.
    for (let i = 0; i < 3; i++) {
      expect((await getDocument(as(manager), t.id)).movements.map((m) => [m.sku, m.type])).toEqual([
        ["LK-100", "TRANSFER_OUT"],
        ["LK-100", "TRANSFER_IN"],
        ["CBL-2", "TRANSFER_OUT"],
        ["CBL-2", "TRANSFER_IN"],
      ]);
    }
    // The ledger lists newest first: the same movements, backwards.
    const ledger = (await listMovements(as(manager), { productId: cable })).rows.map((m) => m.type);
    expect(ledger).toEqual(["TRANSFER_IN", "TRANSFER_OUT", "GOODS_RECEIPT"]);
  });

  it("reverses a transfer back to where the stock came from", async () => {
    await post(store, receipt([line(lock, 1, { serials: "SN-5" })]));
    const t = await post(store, { type: "TRANSFER", fromWarehouseId: main, toWarehouseId: van, documentDate: day, lines: [line(lock, 1, { serials: "SN-5" })] });
    await cancelDocument(as(manager), t.id, { reason: "Wrong van" });
    expect([await qty(lock, main), await qty(lock, van), await serialAt("SN-5")]).toEqual([1, 0, main]);
  });

  it("cancels a draft without touching stock", async () => {
    const d = await createDocument(as(store), receipt([line(cable, 3)]));
    const c = await cancelDocument(as(store), d.id, {});
    expect(c.status).toBe("CANCELLED");
    expect(c.movements).toHaveLength(0);
    await expect(postDocument(as(store), d.id)).rejects.toThrow(/cancelled/i);
  });
});

describe("concurrency and duplicate submissions", () => {
  it("lets only one of two simultaneous issues take the last units", async () => {
    for (let round = 0; round < 8; round++) {
      await post(store, receipt([line(cable, 5)]));
      const results = await Promise.allSettled([post(store, issue([line(cable, 5)])), post(manager, issue([line(cable, 5)]))]);
      expect(results.filter((r) => r.status === "fulfilled"), `round ${round}`).toHaveLength(1);
      expect(await qty(cable, main)).toBe(0);
    }
  });

  it("adds up simultaneous receipts without losing any", async () => {
    await Promise.all(Array.from({ length: 10 }, (_, i) => post(i % 2 ? store : manager, receipt([line(cable, 3)]))));
    expect(await qty(cable, main)).toBe(30);
    expect(await prisma.inventoryMovement.count({ where: { productId: cable } })).toBe(10);
    // Every receipt got its own number.
    expect(new Set((await prisma.stockDocument.findMany({ select: { number: true } })).map((d) => d.number)).size).toBe(10);
  });

  it("posts a document once however often the request is repeated", async () => {
    const body = receipt([line(cable, 4)], { clientRequestId: "req-12345678" });
    const results = await Promise.all([post(store, body), post(store, body), post(store, body)]);
    expect(new Set(results.map((r) => r.id)).size).toBe(1);
    const d = await createDocument(as(store), receipt([line(cable, 1)]));
    await Promise.all([postDocument(as(store), d.id), postDocument(as(store), d.id)]);
    expect(await qty(cable, main)).toBe(5);
    expect(await prisma.inventoryMovement.count()).toBe(2);
    // Somebody else's request id is not theirs to reuse.
    await expect(post(manager, body)).rejects.toBeInstanceOf(ValidationError);
  });
});

describe("who sees what", () => {
  it("shows a technician only their own vehicle", async () => {
    await post(store, receipt([line(cable, 30)]));
    await post(store, { type: "TRANSFER", fromWarehouseId: main, toWarehouseId: van, documentDate: day, lines: [line(cable, 10)] });
    const t = as(tech);
    expect((await listWarehouses(t)).rows.map((w) => w.code)).toEqual(["VAN-KARIM"]);
    const balances = await listBalances(t, { view: "location" });
    expect(balances.rows.map((b) => [b.warehouse?.code, b.quantity])).toEqual([["VAN-KARIM", 10]]);
    expect(balances.rows[0]!.value).toBeNull(); // no costs for technicians
    expect((await listMovements(t, {})).rows.every((m) => m.warehouse.code === "VAN-KARIM")).toBe(true);
    expect((await listDocuments(t, {})).rows.map((d) => d.type)).toEqual(["TRANSFER"]);
    await expect(getWarehouse(t, main)).rejects.toBeInstanceOf(NotFoundError);
    await expect(createDocument(t, issue([line(cable, 1)], van))).rejects.toBeInstanceOf(ForbiddenError);
    expect((await listWarehouses(as(otherTech))).rows).toHaveLength(0);
  });

  it("keeps costs to those who may see them and inventory away from people without access", async () => {
    await post(store, receipt([line(cable, 3)]));
    expect((await getProduct(as(manager), cable)).averageCost).toBe(10);
    expect((await getProduct(as(accountant), cable)).averageCost).toBe(10);
    expect((await getProduct(as(store), cable)).averageCost).toBeNull();
    expect((await getProduct(as(sales), cable)).purchaseCost).toBeNull();
    await expect(listBalances(as(sales), {})).rejects.toBeInstanceOf(ForbiddenError);
    await expect(listProducts(as(viewer), {})).rejects.toBeInstanceOf(NotFoundError);
    await expect(listBalances(as(viewer), {})).rejects.toBeInstanceOf(ForbiddenError);
    await expect(exportLedgerCsv(as(store), {})).rejects.toBeInstanceOf(ForbiddenError);
    const csv = await exportLedgerCsv(as(accountant), {});
    expect(csv).toContain("Goods receipt");
    // A viewer granted inventory access reads balances but cannot move stock.
    const granted = await makeUser("VIEWER", { viewerPermissions: ["inventory.view", "products.view"] });
    // The overall view also lists the lock: none in stock, below its minimum of 2.
    expect((await listBalances(as(granted), {})).rows.map((r) => [r.sku, r.quantity, r.low])).toEqual([
      ["CBL-2", 3, false],
      ["LK-100", 0, true],
    ]);
    await expect(createDocument(as(granted), receipt([line(cable, 1)]))).rejects.toBeInstanceOf(ForbiddenError);
  });

  it("gives the warehouse manager full inventory control but no user or settings management", async () => {
    const perms = as(manager).permissions;
    expect(perms).toEqual(expect.arrayContaining(["products.manage", "warehouses.manage", "inventory.approve", "inventory.reports"]));
    expect(perms).not.toContain("users.manage");
    expect(perms).not.toContain("settings.manage");
    expect(as(store).permissions).not.toContain("inventory.approve");
  });
});
