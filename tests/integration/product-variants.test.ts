import { beforeEach, describe, expect, it } from "vitest";
import type { User } from "@prisma/client";
import { getProduct, listProducts, saveCategory, saveProduct } from "@/server/services/inventory-catalog";
import { addVariants, attachVariant, detachVariant, saveVariant } from "@/server/services/product-variants";
import { saveWarehouse } from "@/server/services/inventory-warehouses";
import { createDocument, postDocument } from "@/server/services/inventory-documents";
import { approveStocktake, createStocktake, getStocktake, saveCounts, submitStocktake, addStocktakeLine } from "@/server/services/stocktakes";
import { ForbiddenError, ValidationError } from "@/server/errors";
import { DEFAULT_TIMEZONE } from "@/lib/constants";
import { todayKey } from "@/lib/time";
import { isValidEan13 } from "@/lib/product-codes";
import { asCurrent, makeUser, prisma, resetDb } from "../helpers";

/** Automatic codes, variants, optional serial numbers and their place in the ledger. */
const day = todayKey(DEFAULT_TIMEZONE);
let manager: User, store: User;
let main: string;
const as = (u: User) => asCurrent(u);

beforeEach(async () => {
  await resetDb();
  manager = await makeUser("WAREHOUSE_MANAGER", { name: "Wael Manager" });
  store = await makeUser("STORE", { name: "Samy Store" });
  main = (await saveWarehouse(as(manager), null, { code: "MAIN", nameEn: "Main store", nameAr: "المخزن الرئيسي", kind: "WAREHOUSE" })).id;
});

const qty = async (productId: string) => (await prisma.stockBalance.aggregate({ where: { productId }, _sum: { quantity: true } }))._sum.quantity?.toNumber() ?? 0;

describe("automatic SKUs and barcodes", () => {
  it("generates a SKU from the category code, or PRD, when none is typed", async () => {
    const m = as(manager);
    const locks = await saveCategory(m, null, { code: "lck", nameEn: "Locks", nameAr: "أقفال" });
    expect(locks.code).toBe("LCK");
    const sub = await saveCategory(m, null, { nameEn: "Door locks", nameAr: "أقفال أبواب", parentId: locks.id });
    const a = await saveProduct(m, null, { nameEn: "Lock A", nameAr: "قفل أ", unitId: "unit-pcs", categoryId: locks.id });
    const b = await saveProduct(m, null, { sku: "", nameEn: "Lock B", nameAr: "قفل ب", unitId: "unit-pcs", categoryId: sub.id });
    const c = await saveProduct(m, null, { nameEn: "Cable", nameAr: "كابل", unitId: "unit-m" });
    expect([a.sku, b.sku, c.sku]).toEqual(["LCK-00001", "LCK-00002", "PRD-00001"]);
    // An edit with the code left empty keeps it; a typed code replaces it and must stay unique.
    const kept = await saveProduct(m, a.id, { sku: "", nameEn: "Lock A2", nameAr: "قفل أ2", unitId: "unit-pcs", categoryId: locks.id, version: a.version });
    expect(kept.sku).toBe("LCK-00001");
    await expect(saveProduct(m, c.id, { sku: "LCK-00002", nameEn: "Cable", nameAr: "كابل", unitId: "unit-m", version: c.version })).rejects.toMatchObject({ fieldErrors: { sku: expect.any(String) } });
  });

  it("skips numbers already taken by hand-typed codes", async () => {
    const m = as(manager);
    await saveProduct(m, null, { sku: "PRD-00001", nameEn: "Typed", nameAr: "مكتوب", unitId: "unit-pcs" });
    const auto = await saveProduct(m, null, { nameEn: "Auto", nameAr: "تلقائي", unitId: "unit-pcs" });
    expect(auto.sku).toBe("PRD-00002");
  });

  it("never gives two products the same SKU when they are created at the same moment", async () => {
    const m = as(manager);
    const made = await Promise.all(Array.from({ length: 12 }, (_, i) => saveProduct(m, null, { nameEn: `Item ${i}`, nameAr: `صنف ${i}`, unitId: "unit-pcs" })));
    const skus = made.map((p) => p.sku);
    expect(new Set(skus).size).toBe(12);
    expect([...skus].sort()).toEqual(Array.from({ length: 12 }, (_, i) => `PRD-${String(i + 1).padStart(5, "0")}`));
  });

  it("issues valid, unique internal EAN-13 barcodes on request and keeps a typed one", async () => {
    const m = as(manager);
    const a = await saveProduct(m, null, { nameEn: "A", nameAr: "أ", unitId: "unit-pcs", generateBarcode: true });
    const b = await saveProduct(m, null, { nameEn: "B", nameAr: "ب", unitId: "unit-pcs", generateBarcode: true });
    const c = await saveProduct(m, null, { nameEn: "C", nameAr: "ج", unitId: "unit-pcs", barcode: "6221234567890", generateBarcode: true });
    expect(isValidEan13(a.barcode!) && isValidEan13(b.barcode!)).toBe(true);
    expect(a.barcode).not.toBe(b.barcode);
    expect(a.barcode!.startsWith("2")).toBe(true);
    expect(c.barcode).toBe("6221234567890");
  });

  it("lets only catalogue managers create products", async () => {
    await expect(saveProduct(as(store), null, { nameEn: "X", nameAr: "س", unitId: "unit-pcs" })).rejects.toBeInstanceOf(ForbiddenError);
  });
});

describe("variants", () => {
  async function lockWithColours() {
    const m = as(manager);
    const p = await saveProduct(m, null, { sku: "SLX", nameEn: "Smart Lock Model X", nameAr: "قفل ذكي موديل X", unitId: "unit-pcs", purchaseCost: 1000, sellingPrice: 1500, warrantyMonths: 24, serialMode: "REQUIRED" });
    const r = await addVariants(m, p.id, {
      variants: [
        { variantNameEn: "Black", variantNameAr: "أسود", colorHex: "#111111" },
        { variantNameEn: "Silver", variantNameAr: "فضي", sellingPrice: 1600, generateBarcode: true },
        { variantNameEn: "Gold", variantNameAr: "ذهبي", sku: "slx-gld" },
      ],
    });
    return { parent: p, ...r };
  }

  it("creates variants with their own codes, prices and barcodes, sharing the product's details", async () => {
    const { parent, created, product } = await lockWithColours();
    expect(created.map((v) => v.sku).sort()).toEqual(["SLX-BLACK", "SLX-GLD", "SLX-SILVER"]);
    expect(product.hasVariants).toBe(true);
    expect(product.variantCount).toBe(3);
    const silver = created.find((v) => v.variantNameEn === "Silver")!;
    expect(silver).toMatchObject({ nameEn: "Smart Lock Model X - Silver", nameAr: "قفل ذكي موديل X - فضي", sellingPrice: 1600, purchaseCost: 1000, warrantyMonths: 24, serialMode: "REQUIRED", parent: { id: parent.id } });
    expect(isValidEan13(silver.barcode!)).toBe(true);
    expect(created.find((v) => v.variantNameEn === "Black")!.colorHex).toBe("#111111");
    // Names are unique within the product.
    await expect(addVariants(as(manager), parent.id, { variants: [{ variantNameEn: "black", variantNameAr: "أسود غامق" }] })).rejects.toBeInstanceOf(ValidationError);
  });

  it("keeps stock on the variants: the product itself cannot be on a document, even through the database", async () => {
    const { parent, created } = await lockWithColours();
    const m = as(manager);
    const bad = await createDocument(m, { type: "RECEIPT", toWarehouseId: main, documentDate: day, lines: [{ productId: parent.id, quantity: 1, serials: ["S1"] }] }).catch((e) => e);
    expect(bad).toBeInstanceOf(ValidationError);
    expect(JSON.stringify(bad.fieldErrors)).toMatch(/choose the variant/i);

    const black = created.find((v) => v.variantNameEn === "Black")!;
    await createDocument(m, { type: "RECEIPT", toWarehouseId: main, documentDate: day, lines: [{ productId: black.id, quantity: 2, serials: ["B1", "B2"], unitCost: 900 }] }, { post: true });
    expect(await qty(black.id)).toBe(2);
    const detail = await getProduct(m, parent.id);
    expect(detail.onHand).toBe(2);
    expect(detail.variants.find((v) => v.id === black.id)!.onHand).toBe(2);
    // The database guard: no movement for a product with variants.
    const line = await prisma.stockDocumentLine.findFirstOrThrow({ where: { productId: black.id } });
    await expect(
      prisma.inventoryMovement.create({ data: { documentId: line.documentId, lineId: line.id, type: "ADJUSTMENT_INCREASE", productId: parent.id, warehouseId: main, quantity: 1, unitCost: 1, balanceAfter: 1, documentDate: new Date(`${day}T00:00:00Z`), createdById: manager.id } }),
    ).rejects.toThrow(/has variants/);
  });

  it("lists products with their variants' total and finds them by a variant code; pickers list variants only", async () => {
    const { parent, created } = await lockWithColours();
    const m = as(manager);
    const top = await listProducts(m, { level: "top" });
    expect(top.rows.map((r) => r.id)).toEqual([parent.id]);
    expect((await listProducts(m, { level: "top", q: "slx-silver" })).rows.map((r) => r.id)).toEqual([parent.id]);
    const picker = await listProducts(m, { q: "SLX" });
    expect(picker.rows.map((r) => r.id).sort()).toEqual(created.map((v) => v.id).sort());
  });

  it("follows the product: renaming and shared details reach every variant; unit locked once a variant moved", async () => {
    const { parent, created } = await lockWithColours();
    const m = as(manager);
    const black = created.find((v) => v.variantNameEn === "Black")!;
    const p = await getProduct(m, parent.id);
    await saveProduct(m, parent.id, { sku: p.sku, nameEn: "Smart Lock X2", nameAr: "قفل ذكي X2", unitId: "unit-pcs", warrantyMonths: 36, serialMode: "REQUIRED", purchaseCost: 1000, sellingPrice: 1500, version: p.version });
    const after = await getProduct(m, black.id);
    expect(after).toMatchObject({ nameEn: "Smart Lock X2 - Black", nameAr: "قفل ذكي X2 - أسود", warrantyMonths: 36, sku: "SLX-BLACK" });

    await createDocument(m, { type: "RECEIPT", toWarehouseId: main, documentDate: day, lines: [{ productId: black.id, quantity: 1, serials: ["B9"], unitCost: 900 }] }, { post: true });
    const p2 = await getProduct(m, parent.id);
    const locked = await saveProduct(m, parent.id, { sku: p2.sku, nameEn: p2.nameEn, nameAr: p2.nameAr, unitId: "unit-box", serialMode: "REQUIRED", version: p2.version }).catch((e) => e);
    expect(locked).toBeInstanceOf(ValidationError);
    expect(locked.fieldErrors.unitId).toBeTruthy();
    // A product whose variant holds stock cannot be retired.
    const retire = await saveProduct(m, parent.id, { sku: p2.sku, nameEn: p2.nameEn, nameAr: p2.nameAr, unitId: "unit-pcs", serialMode: "REQUIRED", isActive: false, version: p2.version }).catch((e) => e);
    expect(retire.fieldErrors.isActive).toBeTruthy();
  });

  it("edits a variant's own fields with optimistic locking and audits every change", async () => {
    const { created, parent } = await lockWithColours();
    const m = as(manager);
    const gold = created.find((v) => v.variantNameEn === "Gold")!;
    const saved = await saveVariant(m, parent.id, gold.id, { variantNameEn: "Rose gold", variantNameAr: "ذهبي وردي", sellingPrice: 1700, minStock: 2, version: gold.version });
    expect(saved).toMatchObject({ nameEn: "Smart Lock Model X - Rose gold", sellingPrice: 1700, minStock: 2, sku: "SLX-GLD" });
    await expect(saveVariant(m, parent.id, gold.id, { variantNameEn: "Gold", variantNameAr: "ذهبي", version: gold.version })).rejects.toMatchObject({ status: 409 });
    const audits = await prisma.auditLog.findMany({ where: { entityId: gold.id }, orderBy: { createdAt: "asc" } });
    expect(audits.map((a) => a.action)).toEqual(["VARIANT_CREATED", "VARIANT_UPDATED"]);
  });

  it("refuses variants on a product that still holds stock, and attaches existing products as variants", async () => {
    const m = as(manager);
    const old = await saveProduct(m, null, { sku: "OLD-BLK", nameEn: "Lock black", nameAr: "قفل أسود", unitId: "unit-pcs", purchaseCost: 50 });
    await createDocument(m, { type: "RECEIPT", toWarehouseId: main, documentDate: day, lines: [{ productId: old.id, quantity: 3 }] }, { post: true });
    await expect(addVariants(m, old.id, { variants: [{ variantNameEn: "Matte", variantNameAr: "مطفي" }] })).rejects.toThrow(/still holds stock/);

    const model = await saveProduct(m, null, { sku: "LOCK-Y", nameEn: "Lock Y", nameAr: "قفل Y", unitId: "unit-pcs", warrantyMonths: 12 });
    const detail = await attachVariant(m, model.id, { productId: old.id, variantNameEn: "Black", variantNameAr: "أسود" });
    expect(detail.variants.map((v) => v.sku)).toEqual(["OLD-BLK"]);
    const moved = await getProduct(m, old.id);
    expect(moved).toMatchObject({ nameEn: "Lock Y - Black", warrantyMonths: 12, onHand: 3, parent: { id: model.id } });
    // Its history stays with it.
    expect(await prisma.inventoryMovement.count({ where: { productId: old.id } })).toBe(1);
    // Mismatched unit is refused.
    const metre = await saveProduct(m, null, { sku: "CBL", nameEn: "Cable", nameAr: "كابل", unitId: "unit-m" });
    await expect(attachVariant(m, model.id, { productId: metre.id, variantNameEn: "Long", variantNameAr: "طويل" })).rejects.toThrow(/different/);

    const back = await detachVariant(m, old.id);
    expect(back.hasVariants).toBe(false);
    expect((await getProduct(m, old.id)).parent).toBeNull();
  });
});

describe("optional serial numbers", () => {
  async function camera() {
    return saveProduct(as(manager), null, { sku: "CAM-1", nameEn: "Camera", nameAr: "كاميرا", unitId: "unit-pcs", purchaseCost: 300, serialMode: "OPTIONAL" });
  }

  it("records serials when given, not for every unit, and moves the recorded ones", async () => {
    const m = as(manager);
    const cam = await camera();
    expect(cam.serialMode).toBe("OPTIONAL");
    await createDocument(m, { type: "RECEIPT", toWarehouseId: main, documentDate: day, lines: [{ productId: cam.id, quantity: 5, serials: ["C1", "C2"] }] }, { post: true });
    expect(await qty(cam.id)).toBe(5);
    expect(await prisma.productSerial.count({ where: { productId: cam.id, warehouseId: main } })).toBe(2);
    // More serials than units is refused.
    await expect(createDocument(m, { type: "RECEIPT", toWarehouseId: main, documentDate: day, lines: [{ productId: cam.id, quantity: 1, serials: ["C3", "C4"] }] })).rejects.toMatchObject({ fieldErrors: { "lines.0.serials": expect.stringMatching(/at most 1 serial/i) } });
    // Issue 3 plain units: 2 left with their 2 serials: allowed.
    await createDocument(m, { type: "ISSUE", fromWarehouseId: main, documentDate: day, lines: [{ productId: cam.id, quantity: 3 }] }, { post: true });
    // Issuing one more plain unit would leave 2 serials on 1 unit: refused, name the serial.
    await expect(createDocument(m, { type: "ISSUE", fromWarehouseId: main, documentDate: day, lines: [{ productId: cam.id, quantity: 1 }] }, { post: true })).rejects.toThrow(/name the serial numbers/i);
    await createDocument(m, { type: "ISSUE", fromWarehouseId: main, documentDate: day, lines: [{ productId: cam.id, quantity: 1, serials: ["C2"] }] }, { post: true });
    expect((await prisma.productSerial.findUniqueOrThrow({ where: { productId_serial: { productId: cam.id, serial: "C2" } } })).warehouseId).toBeNull();
    expect(await qty(cam.id)).toBe(1);
  });

  it("relaxes mandatory serials to optional after movements, but not the other way", async () => {
    const m = as(manager);
    const lock = await saveProduct(m, null, { sku: "LK", nameEn: "Lock", nameAr: "قفل", unitId: "unit-pcs", purchaseCost: 10, serialMode: "REQUIRED" });
    await createDocument(m, { type: "RECEIPT", toWarehouseId: main, documentDate: day, lines: [{ productId: lock.id, quantity: 1, serials: ["L1"] }] }, { post: true });
    const relaxed = await saveProduct(m, lock.id, { sku: "LK", nameEn: "Lock", nameAr: "قفل", unitId: "unit-pcs", purchaseCost: 10, serialMode: "OPTIONAL", version: lock.version });
    expect(relaxed.serialMode).toBe("OPTIONAL");
    const back = await saveProduct(m, lock.id, { sku: "LK", nameEn: "Lock", nameAr: "قفل", unitId: "unit-pcs", purchaseCost: 10, serialMode: "REQUIRED", version: relaxed.version }).catch((e) => e);
    expect(back.fieldErrors.serialMode).toBeTruthy();
    const off = await saveProduct(m, lock.id, { sku: "LK", nameEn: "Lock", nameAr: "قفل", unitId: "unit-pcs", purchaseCost: 10, serialMode: "NONE", version: relaxed.version }).catch((e) => e);
    expect(off.fieldErrors.serialMode).toBeTruthy();
  });

  it("counts optional serials in a stocktake and adjusts the missing ones by name", async () => {
    const m = as(manager);
    const cam = await camera();
    await createDocument(m, { type: "RECEIPT", toWarehouseId: main, documentDate: day, lines: [{ productId: cam.id, quantity: 4, serials: ["C1", "C2"] }] }, { post: true });
    const st = await createStocktake(m, { warehouseId: main });
    const detail = await getStocktake(m, st.id);
    const line = detail.lines.find((l) => l.product.id === cam.id)!;
    expect(line.systemSerials).toEqual(["C1", "C2"]);
    // Counted 1 unit without naming serials: the counter must say which serial is still there.
    await saveCounts(m, st.id, { lines: [{ lineId: line.id, countedQuantity: 1, reason: "Two broken, one lost" }] });
    await expect(submitStocktake(m, st.id, {})).rejects.toThrow(/list the serial numbers/i);
    await saveCounts(m, st.id, { lines: [{ lineId: line.id, countedQuantity: 1, countedSerials: ["C1"], reason: "Two broken, one lost" }] });
    await submitStocktake(m, st.id, {});
    await approveStocktake(m, st.id, {});
    expect(await qty(cam.id)).toBe(1);
    const serials = await prisma.productSerial.findMany({ where: { productId: cam.id }, orderBy: { serial: "asc" } });
    expect(serials.map((s) => [s.serial, s.warehouseId])).toEqual([["C1", main], ["C2", null]]);
  });

  it("refuses a product with variants as a stocktake line", async () => {
    const m = as(manager);
    const p = await saveProduct(m, null, { nameEn: "Panel", nameAr: "شاشة", unitId: "unit-pcs" });
    await addVariants(m, p.id, { variants: [{ variantNameEn: "White", variantNameAr: "أبيض" }] });
    const st = await createStocktake(m, { warehouseId: main });
    await expect(addStocktakeLine(m, st.id, { productId: p.id })).rejects.toMatchObject({ fieldErrors: { productId: expect.stringMatching(/choose the variant/i) } });
    void postDocument;
  });
});
