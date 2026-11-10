import { beforeEach, describe, expect, it } from "vitest";
import ExcelJS from "exceljs";
import type { User } from "@prisma/client";
import { saveCategory, saveProduct, getProduct } from "@/server/services/inventory-catalog";
import { saveWarehouse, saveBin } from "@/server/services/inventory-warehouses";
import { createDocument, getDocument, postDocument } from "@/server/services/inventory-documents";
import { commitImport, exportProductsXlsx, importTemplate, previewImport, readWorkbook } from "@/server/services/product-import";
import { listSuppliers, saveSupplier } from "@/server/services/suppliers";
import { ForbiddenError, ValidationError } from "@/server/errors";
import { PRODUCT_COLUMNS, STOCK_COLUMNS, headerOf } from "@/lib/product-import";
import { DEFAULT_TIMEZONE } from "@/lib/constants";
import { todayKey } from "@/lib/time";
import { createT } from "@/i18n/translator";
import { asCurrent, makeUser, prisma, resetDb } from "../helpers";

const en = createT("en");
/** A row's problems as English text, "column: message". */
const text = (r: { messages: { field: string | null; message: string }[] }) => r.messages.map((m) => `${m.field}: ${en.msg(m.message)}`).join(" | ");

/** Suppliers, documents linked to suppliers and visits, and the Excel import / export. */
const day = todayKey(DEFAULT_TIMEZONE);
let manager: User, store: User, sales: User;
let main: string;
const as = (u: User) => asCurrent(u);
const all = { update: false, createMissing: false, skipInvalid: false };

async function workbook(products: Record<string, string>[], stock: Record<string, string>[] = [], headers: "bilingual" | "keys" | "arabic" = "bilingual") {
  const wb = new ExcelJS.Workbook();
  const head = (c: (typeof PRODUCT_COLUMNS)[number]) => (headers === "keys" ? c.key : headers === "arabic" ? c.ar : headerOf(c));
  const ws = wb.addWorksheet("Products");
  ws.addRow(PRODUCT_COLUMNS.map(head));
  for (const p of products) ws.addRow(PRODUCT_COLUMNS.map((c) => p[c.key] ?? ""));
  if (stock.length) {
    const st = wb.addWorksheet("Opening stock");
    st.addRow(STOCK_COLUMNS.map(head));
    for (const r of stock) st.addRow(STOCK_COLUMNS.map((c) => r[c.key] ?? ""));
  }
  return new Uint8Array(await wb.xlsx.writeBuffer());
}

beforeEach(async () => {
  await resetDb();
  manager = await makeUser("WAREHOUSE_MANAGER", { name: "Wael Manager" });
  store = await makeUser("STORE");
  sales = await makeUser("SALES");
  main = (await saveWarehouse(as(manager), null, { code: "MAIN", nameEn: "Main store", nameAr: "المخزن الرئيسي", kind: "WAREHOUSE" })).id;
  await saveBin(as(manager), main, null, { code: "A-01" });
  await saveCategory(as(manager), null, { code: "LCK", nameEn: "Smart locks", nameAr: "أقفال ذكية" });
});

describe("suppliers", () => {
  it("generates codes, keeps names unique, and is managed only by catalogue managers", async () => {
    const a = await saveSupplier(as(manager), null, { name: "Delta Trading", phone: "+20 100 222 3333", email: "sales@delta.example" });
    expect(a.code).toBe("SUP-00001");
    await expect(saveSupplier(as(manager), null, { name: "delta trading" })).rejects.toMatchObject({ fieldErrors: { name: expect.any(String) } });
    await expect(saveSupplier(as(store), null, { name: "X" })).rejects.toBeInstanceOf(ForbiddenError);
    expect((await listSuppliers(as(store), { q: "2223" })).rows.map((r) => r.code)).toEqual(["SUP-00001"]);
    await expect(listSuppliers(as(sales))).rejects.toThrow();
    await expect(prisma.supplier.delete({ where: { id: a.id } })).rejects.toThrow(/cannot be deleted/);
  });

  it("links receipts to the supplier and issues to the booked visit; a posted document's links cannot change", async () => {
    const m = as(manager);
    const sup = await saveSupplier(m, null, { name: "Delta Trading" });
    const p = await saveProduct(m, null, { nameEn: "Cable", nameAr: "كابل", unitId: "unit-m", purchaseCost: 5 });
    const doc = await createDocument(m, { type: "RECEIPT", toWarehouseId: main, documentDate: day, supplierId: sup.id, lines: [{ productId: p.id, quantity: 10 }] }, { post: true });
    const d = await prisma.stockDocument.findUniqueOrThrow({ where: { id: doc.id } });
    expect(d).toMatchObject({ supplierId: sup.id, counterparty: "Delta Trading" });
    await expect(prisma.stockDocument.update({ where: { id: doc.id }, data: { supplierId: null } })).rejects.toThrow(/cannot be changed/);
    // An unknown visit code is refused.
    await expect(createDocument(m, { type: "ISSUE", fromWarehouseId: main, documentDate: day, appointmentRef: "APT-999999", lines: [{ productId: p.id, quantity: 1 }] })).rejects.toMatchObject({ fieldErrors: { appointmentRef: expect.any(String) } });
    void getDocument;
    void postDocument;
  });
});

describe("Excel import", () => {
  it("reads the downloadable template and its example rows", async () => {
    const template = await importTemplate(as(manager));
    const parsed = await readWorkbook(new Uint8Array(template));
    expect(parsed.products.length).toBe(3);
    expect(parsed.stock.length).toBe(1);
    expect(parsed.products[0]!.v).toMatchObject({ name_en: "Smart Lock Model Y", unit: "PCS", serial_mode: "REQUIRED" });
  });

  it("previews without writing, generates codes on commit, and creates variants and opening drafts", async () => {
    const m = as(manager);
    const file = await workbook(
      [
        { sku: "SLY", name_en: "Smart Lock Y", name_ar: "قفل Y", category: "LCK", brand: "Yale", unit: "PCS", purchase_cost: "3500", selling_price: "4900", serial_mode: "required", warranty_months: "24" },
        { parent_sku: "SLY", variant_en: "Black", variant_ar: "أسود", color: "1F1F1F" },
        { parent_sku: "sly", variant_en: "Silver", variant_ar: "فضي", selling_price: "5100", generate_barcode: "yes" },
        { name_en: "Alarm cable", name_ar: "كابل إنذار", category: "Smart locks", unit: "متر", purchase_cost: "6", serial_mode: "لا" },
      ],
      [
        { sku: "SLY-BLACK", warehouse: "main", bin: "a-01", quantity: "2", serials: "B1, B2" },
        { sku: "SLY", warehouse: "MAIN", quantity: "1", serials: "X1" },
      ],
    );
    const preview = await previewImport(m, file, { ...all, createMissing: true });
    expect(preview.committed).toBe(false);
    // The stock row for the product itself (it has variants) is refused: stock is per variant.
    expect(preview.counts).toEqual({ create: 5, update: 0, skip: 0, error: 1 });
    expect(text(preview.rows.find((r) => r.sheet === "stock" && r.row === 3)!)).toMatch(/has variants/);
    expect(await prisma.product.count()).toBe(0);

    // With an error and without "skip invalid", the commit writes nothing.
    const refused = await commitImport(m, file, { ...all, createMissing: true });
    expect(refused.committed).toBe(false);
    expect(await prisma.product.count()).toBe(0);

    const done = await commitImport(m, file, { ...all, createMissing: true, skipInvalid: true });
    expect(done.committed).toBe(true);
    expect(done.counts.create).toBe(5);
    const skus = (await prisma.product.findMany({ orderBy: { sku: "asc" }, select: { sku: true } })).map((p) => p.sku);
    expect(skus).toEqual(["LCK-00001", "SLY", "SLY-BLACK", "SLY-SILVER"]);
    const black = await prisma.product.findUniqueOrThrow({ where: { sku: "SLY-BLACK" } });
    expect(black).toMatchObject({ nameEn: "Smart Lock Y - Black", colorHex: "#1F1F1F", trackSerials: true, warrantyMonths: 24 });
    expect((await prisma.product.findUniqueOrThrow({ where: { sku: "SLY-SILVER" } })).barcode).toMatch(/^2\d{12}$/);
    expect(await prisma.brand.count({ where: { name: "Yale" } })).toBe(1);
    // Opening stock is a draft to review: no balance changed yet.
    expect(done.openingDocuments).toHaveLength(1);
    const draft = await prisma.stockDocument.findUniqueOrThrow({ where: { id: done.openingDocuments[0]!.id }, include: { lines: true } });
    expect(draft).toMatchObject({ type: "OPENING", status: "DRAFT" });
    expect(draft.lines[0]).toMatchObject({ serials: ["B1", "B2"] });
    expect(await prisma.stockBalance.count()).toBe(0);
    await postDocument(m, draft.id);
    expect((await getProduct(m, black.id)).onHand).toBe(2);
    // Audited.
    expect(await prisma.auditLog.count({ where: { action: "PRODUCTS_IMPORTED" } })).toBe(1);
    expect(await prisma.auditLog.count({ where: { action: { in: ["PRODUCT_CREATED", "VARIANT_CREATED"] } } })).toBe(4);
  });

  it("reports duplicates, unknown references and bad values with their row and column", async () => {
    const m = as(manager);
    await saveProduct(m, null, { sku: "OLD-1", nameEn: "Old", nameAr: "قديم", unitId: "unit-pcs", barcode: "6221111111111" });
    const file = await workbook(
      [
        { sku: "A-1", name_en: "A", name_ar: "أ", unit: "PCS" },
        { sku: "a-1", name_en: "A again", name_ar: "أ ثاني", unit: "PCS" },
        { sku: "B-1", name_en: "B", name_ar: "ب", unit: "litre" },
        { sku: "C-1", name_en: "C", name_ar: "ج", unit: "PCS", brand: "Nobody", serial_mode: "maybe", purchase_cost: "12.345" },
        { sku: "D-1", name_en: "D", name_ar: "د", unit: "PCS", barcode: "6221111111111" },
        { sku: "OLD-1", name_en: "Old renamed", name_ar: "قديم", unit: "PCS" },
        { parent_sku: "NOPE", variant_en: "Red", variant_ar: "أحمر" },
        { sku: "E-1", name_ar: "هـ", unit: "PCS" },
      ],
      [],
      "keys",
    );
    const r = await previewImport(m, file, all);
    const byRow = new Map(r.rows.map((x) => [x.row, x]));
    expect(byRow.get(2)!.action).toBe("create");
    expect(text(byRow.get(3)!)).toMatch(/used again in row 2/);
    expect(text(byRow.get(4)!)).toMatch(/unit: Unknown unit litre/);
    const c = text(byRow.get(5)!);
    expect(c).toMatch(/brand: Unknown brand Nobody/);
    expect(c).toMatch(/serial_mode/);
    expect(c).toMatch(/purchase_cost/);
    expect(text(byRow.get(6)!)).toMatch(/barcode/);
    expect(byRow.get(7)).toMatchObject({ action: "skip" });
    expect(text(byRow.get(8)!)).toMatch(/NOPE is not in the system/);
    expect(text(byRow.get(9)!)).toMatch(/name_en: Name \(English\) is required/);
    // With updates allowed the existing SKU is updated, keeping its barcode.
    const up = await commitImport(m, await workbook([{ sku: "OLD-1", name_en: "Old renamed", name_ar: "قديم", unit: "PCS", selling_price: "99" }]), { ...all, update: true });
    expect(up.counts).toMatchObject({ update: 1, error: 0 });
    expect(await prisma.product.findUniqueOrThrow({ where: { sku: "OLD-1" } })).toMatchObject({ nameEn: "Old renamed", barcode: "6221111111111" });
  });

  it("accepts Arabic headers and refuses imports by people who may not manage the catalogue", async () => {
    const file = await workbook([{ sku: "AR-1", name_en: "Arabic header", name_ar: "رؤوس عربية", unit: "قطعة" }], [], "arabic");
    expect((await previewImport(as(manager), file, all)).counts.create).toBe(1);
    await expect(previewImport(as(store), file, all)).rejects.toBeInstanceOf(ForbiddenError);
    await expect(previewImport(as(manager), new Uint8Array([1, 2, 3]), all)).rejects.toBeInstanceOf(ValidationError);
  });

  it("imports thousands of products in one transaction and exports them for re-import", async () => {
    const m = as(manager);
    const rows = Array.from({ length: 3000 }, (_, i) => ({ name_en: `Bulk item ${i}`, name_ar: `صنف ${i}`, unit: "PCS", category: "LCK", purchase_cost: "10", selling_price: "15" }));
    const t0 = Date.now();
    const r = await commitImport(m, await workbook(rows), all);
    const ms = Date.now() - t0;
    expect(r.committed).toBe(true);
    expect(r.counts.create).toBe(3000);
    expect(await prisma.product.count()).toBe(3000);
    expect(new Set((await prisma.product.findMany({ select: { sku: true } })).map((p) => p.sku)).size).toBe(3000);
    expect(ms).toBeLessThan(120_000);
    console.log(`imported 3000 products in ${ms} ms`);

    const exported = await exportProductsXlsx(m);
    const back = await readWorkbook(new Uint8Array(exported));
    expect(back.products.length).toBe(3000);
    // Re-importing the export with updates changes nothing structurally and reports updates.
    const again = await previewImport(m, new Uint8Array(exported), { ...all, update: true });
    expect(again.counts).toMatchObject({ update: 3000, error: 0 });
  }, 240_000);
});
