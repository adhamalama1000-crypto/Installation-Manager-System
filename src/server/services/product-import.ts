import "server-only";
import ExcelJS from "exceljs";
import { Prisma } from "@prisma/client";
import { createT, msg } from "@/i18n/translator";
import { DOC_PREFIX, formatDocNumber, normalizeCode, productSchema, serialFlags, serialModeOf, variantSchema, type SerialMode } from "@/lib/inventory";
import {
  MAX_IMPORT_BYTES,
  MAX_IMPORT_ROWS,
  MAX_STOCK_ROWS,
  PRODUCT_COLUMNS,
  PRODUCTS_SHEET,
  STOCK_COLUMNS,
  STOCK_SHEET,
  columnKeyOf,
  headerOf,
  parseSerialMode,
  parseYesNo,
  splitSerials,
  type ImportColumn,
} from "@/lib/product-import";
import { variantCodeCandidates } from "@/lib/product-codes";
import { foldText } from "@/lib/text";
import { fieldErrorsFromZod } from "@/lib/validation";
import { prisma, type Tx } from "../db";
import { assertCan, hasPermission } from "../access";
import type { CurrentUser } from "../auth/session";
import { ValidationError } from "../errors";
import { canSeeCosts, nextSequence, num, numOrNull, today } from "./inventory-common";
import { sharedOf, variantFullName } from "./inventory-catalog";
import { nextInternalBarcode, nextVariantCode, reserveBarcodes, reserveSkus, skuPrefix } from "./product-codes";
import { messageData } from "./notifications";

/**
 * Bulk product import and export (Excel .xlsx).
 *
 * Import is two steps with the same code path: a preview (validate every row, change nothing) and
 * a commit (validate again inside one transaction, then write). A commit writes nothing while any
 * row has an error, unless the user explicitly chose to skip invalid rows; either way the result
 * lists every row with what happened to it. Codes left empty are generated exactly as in the form.
 * Opening stock never changes balances directly: it becomes DRAFT opening-balance documents that
 * an approver reviews and posts through the ledger.
 */

export type ImportOptions = { update: boolean; createMissing: boolean; skipInvalid: boolean };
export type RowAction = "create" | "update" | "skip" | "error";
/** A problem on a row: the column (key, see lib/product-import) and an encoded message (i18n `msg`). */
export type RowMessage = { field: string | null; message: string };
export type RowResult = { sheet: "products" | "stock"; row: number; sku: string | null; name: string | null; action: RowAction; messages: RowMessage[] };
export type ImportResult = {
  committed: boolean;
  rows: RowResult[];
  counts: Record<RowAction, number>;
  openingDocuments: { id: string; number: string; warehouse: string }[];
};

type Rows = { row: number; v: Record<string, string> }[];
type Parsed = { products: Rows; stock: Rows };

// ---- Reading the workbook ----------------------------------------------------------------------

function cellText(value: ExcelJS.CellValue): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "number") return Number.isInteger(value) ? String(value) : String(Math.round(value * 1e6) / 1e6);
  if (typeof value === "boolean") return value ? "yes" : "no";
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  if (typeof value === "object") {
    if ("richText" in value && Array.isArray(value.richText)) return value.richText.map((r) => r.text).join("").trim();
    if ("result" in value) return cellText(value.result as ExcelJS.CellValue);
    if ("text" in value && typeof value.text === "string") return value.text.trim();
    if ("error" in value) return "";
  }
  return String(value).trim();
}

function readSheet(ws: ExcelJS.Worksheet, columns: ImportColumn[], max: number): Rows | null {
  // The header is the first of the top five rows that names at least two known columns.
  let headerRow = 0;
  let keys = new Map<number, string>();
  for (let r = 1; r <= Math.min(5, ws.rowCount); r++) {
    const found = new Map<number, string>();
    ws.getRow(r).eachCell({ includeEmpty: false }, (cell, col) => {
      const k = columnKeyOf(cellText(cell.value), columns);
      if (k && ![...found.values()].includes(k)) found.set(col, k);
    });
    if (found.size >= 2) {
      headerRow = r;
      keys = found;
      break;
    }
  }
  if (!headerRow) return null;
  const out: Rows = [];
  for (let r = headerRow + 1; r <= ws.rowCount; r++) {
    const row = ws.getRow(r);
    const v: Record<string, string> = {};
    let any = false;
    for (const [col, key] of keys) {
      const text = cellText(row.getCell(col).value);
      v[key] = text;
      if (text) any = true;
    }
    if (!any) continue;
    out.push({ row: r, v });
    if (out.length > max) throw new ValidationError({ file: msg("productImport.errors.tooManyRows", { max }) }, msg("productImport.errors.tooManyRows", { max }));
  }
  return out;
}

export async function readWorkbook(bytes: Uint8Array | null): Promise<Parsed> {
  // null: the body was cut off at the size limit (readLimitedBody).
  if (bytes && !bytes.byteLength) throw new ValidationError({ file: msg("productImport.errors.file") }, msg("productImport.errors.file"));
  if (!bytes || bytes.byteLength > MAX_IMPORT_BYTES) {
    const m = msg("productImport.errors.tooLarge", { mb: MAX_IMPORT_BYTES / 1024 / 1024 });
    throw new ValidationError({ file: m }, m);
  }
  // .xlsx is a zip file: "PK\x03\x04".
  if (!(bytes[0] === 0x50 && bytes[1] === 0x4b)) throw new ValidationError({ file: msg("productImport.errors.read") }, msg("productImport.errors.read"));
  const wb = new ExcelJS.Workbook();
  try {
    await wb.xlsx.load(Buffer.from(bytes) as unknown as ArrayBuffer);
  } catch {
    throw new ValidationError({ file: msg("productImport.errors.read") }, msg("productImport.errors.read"));
  }
  const byName = (names: string[]) => wb.worksheets.find((w) => names.some((n) => foldText(w.name) === foldText(n)));
  const productSheet = byName([PRODUCTS_SHEET.en, PRODUCTS_SHEET.ar]) ?? wb.worksheets.find((w) => readSheet(w, PRODUCT_COLUMNS, Number.MAX_SAFE_INTEGER) !== null && w !== byName([STOCK_SHEET.en, STOCK_SHEET.ar]));
  const products = productSheet ? readSheet(productSheet, PRODUCT_COLUMNS, MAX_IMPORT_ROWS) : null;
  const stockSheet = byName([STOCK_SHEET.en, STOCK_SHEET.ar]);
  const stock = stockSheet ? (readSheet(stockSheet, STOCK_COLUMNS, MAX_STOCK_ROWS) ?? []) : [];
  if (!products && !stock.length) throw new ValidationError({ file: msg("productImport.errors.noSheet") }, msg("productImport.errors.noSheet"));
  return { products: products ?? [], stock };
}

// ---- Planning (validation) ---------------------------------------------------------------------

type ProductPlan = {
  kind: "product";
  row: number;
  existingId: string | null;
  /** Resolved values for the product form fields (codes may be null = generate). */
  data: Omit<Prisma.ProductUncheckedCreateInput, "sku"> & { sku: string | null };
  serialMode: SerialMode;
  generateBarcode: boolean;
  newBrand?: string;
  newCategory?: { name: string; parent: string | null };
};
type VariantPlan = {
  kind: "variant";
  row: number;
  existingId: string | null;
  parentSku: string;
  sku: string | null;
  barcode: string | null;
  generateBarcode: boolean;
  variantNameEn: string;
  variantNameAr: string;
  colorHex: string | null;
  purchaseCost: number | null;
  sellingPrice: number | null;
  minStock: number;
  isActive: boolean;
};
type StockPlan = { row: number; sku: string; warehouseId: string; warehouseCode: string; binId: string | null; quantity: number; unitCost: number | null; serials: string[] };
type Plan = { results: RowResult[]; products: ProductPlan[]; variants: VariantPlan[]; stock: StockPlan[] };

const numberOrBlank = (s: string) => s.replace(/[,\s]/g, "");

async function plan(db: Tx | typeof prisma, user: CurrentUser, parsed: Parsed, opts: ImportOptions): Promise<Plan> {
  const [units, categories, brands, warehouses] = await Promise.all([
    db.unit.findMany({ select: { id: true, code: true, nameEn: true, nameAr: true, isActive: true, allowsFraction: true } }),
    db.catalogCategory.findMany({ select: { id: true, code: true, nameEn: true, nameAr: true, parentId: true, isActive: true } }),
    db.brand.findMany({ select: { id: true, name: true, isActive: true } }),
    db.warehouse.findMany({ where: { isActive: true }, select: { id: true, code: true, bins: { where: { isActive: true }, select: { id: true, code: true } } } }),
  ]);
  const unitBy = new Map<string, (typeof units)[number]>();
  for (const u of units) for (const k of [u.code, u.nameEn, u.nameAr]) unitBy.set(foldText(k), u);
  const catById = new Map(categories.map((c) => [c.id, c]));
  const catBy = new Map<string, (typeof categories)[number]>();
  for (const c of categories) {
    const parent = c.parentId ? catById.get(c.parentId) : null;
    const keys = [c.nameEn, c.nameAr, ...(c.code ? [c.code] : [])];
    if (parent) for (const p of [parent.nameEn, parent.nameAr]) for (const n of [c.nameEn, c.nameAr]) keys.push(`${p} > ${n}`, `${p} › ${n}`, `${p}/${n}`);
    // A top-level name wins over a subcategory with the same name.
    for (const k of keys) if (!catBy.has(foldText(k)) || !c.parentId) catBy.set(foldText(k), c);
  }
  const brandBy = new Map(brands.map((b) => [foldText(b.name), b]));
  const whBy = new Map(warehouses.map((w) => [w.code, w]));

  const skusInFile = new Set<string>();
  const barcodesInFile = new Set<string>();
  for (const r of parsed.products) {
    for (const k of ["sku", "parent_sku"]) {
      const c = normalizeCode(r.v[k] ?? "") as string;
      if (c) skusInFile.add(c);
    }
    const b = normalizeCode(r.v.barcode ?? "") as string;
    if (b) barcodesInFile.add(b);
  }
  for (const r of parsed.stock) {
    const c = normalizeCode(r.v.sku ?? "") as string;
    if (c) skusInFile.add(c);
  }
  const [existing, existingBarcodes] = await Promise.all([
    skusInFile.size
      ? db.product.findMany({
          where: { sku: { in: [...skusInFile] } },
          select: { id: true, sku: true, barcode: true, parentId: true, hasVariants: true, unitId: true, trackSerials: true, serialsOptional: true, purchaseCost: true, parent: { select: { sku: true } } },
        })
      : [],
    barcodesInFile.size ? db.product.findMany({ where: { barcode: { in: [...barcodesInFile] } }, select: { id: true, barcode: true } }) : [],
  ]);
  const existingBy = new Map(existing.map((p) => [p.sku, p]));
  const barcodeOwner = new Map(existingBarcodes.map((p) => [p.barcode!, p.id]));
  const moved = existing.length
    ? new Set((await db.inventoryMovement.groupBy({ by: ["productId"], where: { productId: { in: existing.map((p) => p.id) } } })).map((m) => m.productId))
    : new Set<string>();
  const stocked = existing.length
    ? new Set((await db.stockBalance.groupBy({ by: ["productId"], where: { productId: { in: existing.map((p) => p.id) }, quantity: { not: 0 } } })).map((m) => m.productId))
    : new Set<string>();

  const results: RowResult[] = [];
  const products: ProductPlan[] = [];
  const variants: VariantPlan[] = [];
  const seenSku = new Map<string, number>();
  const seenBarcode = new Map<string, number>();
  /** Products in this file that will exist after the import (by SKU), and their serial mode. */
  const fileProducts = new Map<string, { serialMode: SerialMode; isVariantParent: boolean }>();
  const fileVariants = new Map<string, { serialMode: SerialMode | null; parentSku: string }>();

  // Products first (variants may refer to them wherever they are in the file).
  const productRows = parsed.products.filter((r) => !(normalizeCode(r.v.parent_sku ?? "") as string));
  const variantRows = parsed.products.filter((r) => !!(normalizeCode(r.v.parent_sku ?? "") as string));
  const parentsInFile = new Set(variantRows.map((r) => normalizeCode(r.v.parent_sku) as string));

  const yesNo = (raw: string | undefined, field: string, errors: RowMessage[], def: boolean) => {
    const v = parseYesNo(raw ?? "");
    if (v === undefined) {
      errors.push({ field, message: msg("productImport.errors.yesNo") });
      return def;
    }
    return v ?? def;
  };
  const noteDuplicates = (sku: string | null, barcode: string | null, row: number, errors: RowMessage[], ownId: string | null) => {
    if (sku) {
      const first = seenSku.get(sku);
      if (first !== undefined) errors.push({ field: "sku", message: msg("productImport.errors.duplicateInFile", { row: first }) });
      else seenSku.set(sku, row);
    }
    if (barcode) {
      const first = seenBarcode.get(barcode);
      if (first !== undefined) errors.push({ field: "barcode", message: msg("productImport.errors.duplicateBarcodeInFile", { row: first }) });
      else seenBarcode.set(barcode, row);
      const owner = barcodeOwner.get(barcode);
      if (owner && owner !== ownId) errors.push({ field: "barcode", message: msg("catalog.errors.barcodeTaken") });
    }
  };
  // Schema field names → spreadsheet columns.
  const COLUMN: Record<string, string> = { nameEn: "name_en", nameAr: "name_ar", variantNameEn: "variant_en", variantNameAr: "variant_ar", colorHex: "color", unitId: "unit", categoryId: "category", brandId: "brand", purchaseCost: "purchase_cost", sellingPrice: "selling_price", minStock: "min_stock", warrantyMonths: "warranty_months", serialMode: "serial_mode", trackSerials: "serial_mode", isActive: "active" };
  const zodErrors = (e: Parameters<typeof fieldErrorsFromZod>[0]): RowMessage[] => Object.entries(fieldErrorsFromZod(e)).map(([k, m]) => ({ field: COLUMN[k] ?? k, message: m }));

  for (const r of productRows) {
    const v = r.v;
    const errors: RowMessage[] = [];
    const sku = (normalizeCode(v.sku ?? "") as string) || null;
    const ex = sku ? existingBy.get(sku) : undefined;
    const name = v.name_en || v.name_ar || null;
    if (ex && !opts.update) {
      results.push({ sheet: "products", row: r.row, sku, name, action: "skip", messages: [{ field: "sku", message: msg("productImport.errors.exists") }] });
      continue;
    }
    if (ex?.parentId) errors.push({ field: "parent_sku", message: msg("productImport.errors.noUpdateVariantParent") });
    // References by name or code.
    let unitId = "";
    const unit = v.unit ? unitBy.get(foldText(v.unit)) : undefined;
    if (v.unit && !unit) errors.push({ field: "unit", message: msg("productImport.errors.unknownUnit", { value: v.unit }) });
    else if (unit) unitId = unit.id;
    let categoryId: string | null = null;
    let newCategory: ProductPlan["newCategory"];
    if (v.category) {
      const c = catBy.get(foldText(v.category));
      if (c) categoryId = c.id;
      else if (opts.createMissing) {
        const parts = v.category.split(/\s*[>›/]\s*/).filter(Boolean);
        const parent = parts.length > 1 ? catBy.get(foldText(parts[0]!)) : null;
        if (parts.length > 2 || (parts.length === 2 && parent?.parentId)) errors.push({ field: "category", message: msg("catalog.errors.twoLevels") });
        else newCategory = { name: parts[parts.length - 1]!, parent: parts.length === 2 ? (parent?.id ?? parts[0]!) : null };
      } else errors.push({ field: "category", message: msg("productImport.errors.unknownCategory", { value: v.category }) });
    }
    let brandId: string | null = null;
    let newBrand: string | undefined;
    if (v.brand) {
      const b = brandBy.get(foldText(v.brand));
      if (b) brandId = b.id;
      else if (opts.createMissing) newBrand = v.brand.trim();
      else errors.push({ field: "brand", message: msg("productImport.errors.unknownBrand", { value: v.brand }) });
    }
    const mode = parseSerialMode(v.serial_mode ?? "");
    if (mode === undefined) errors.push({ field: "serial_mode", message: msg("productImport.errors.serialMode") });
    const generateBarcode = yesNo(v.generate_barcode, "generate_barcode", errors, false);
    const isActive = yesNo(v.active, "active", errors, true);
    const parsedInput = productSchema.safeParse({
      sku,
      barcode: v.barcode,
      nameEn: v.name_en,
      nameAr: v.name_ar,
      categoryId: categoryId ?? (newCategory ? "pending" : null),
      brandId: brandId ?? (newBrand ? "pending" : null),
      model: v.model,
      description: v.description,
      unitId: unitId || (v.unit ? "unknown" : ""),
      purchaseCost: numberOrBlank(v.purchase_cost ?? ""),
      sellingPrice: numberOrBlank(v.selling_price ?? ""),
      minStock: numberOrBlank(v.min_stock ?? ""),
      warrantyMonths: numberOrBlank(v.warranty_months ?? ""),
      serialMode: mode ?? "NONE",
      isActive,
    });
    if (!parsedInput.success) errors.push(...zodErrors(parsedInput.error).filter((e) => !(e.field === "unit" && v.unit)));
    const barcode = parsedInput.success ? parsedInput.data.barcode : null;
    noteDuplicates(sku, barcode, r.row, errors, ex?.id ?? null);
    const serialMode: SerialMode = mode ?? (ex ? serialModeOf(ex) : "NONE");
    if (unit?.allowsFraction && serialMode !== "NONE") errors.push({ field: "serial_mode", message: msg("catalog.errors.serialsWhole") });
    if (ex && parsedInput.success) {
      // The same locks as the product form: unit and serial mode once stock has moved.
      if (moved.has(ex.id) && unitId && unitId !== ex.unitId) errors.push({ field: "unit", message: msg("catalog.errors.unitLocked") });
      const from = serialModeOf(ex);
      if (moved.has(ex.id) && from !== serialMode && !(from === "REQUIRED" && serialMode === "OPTIONAL") && !(from === "NONE" && serialMode === "OPTIONAL")) errors.push({ field: "serial_mode", message: msg("serialModes.relaxOnly") });
      if (ex.hasVariants && (unitId !== ex.unitId || from !== serialMode)) errors.push({ field: "unit", message: msg("variants.errors.sharedLocked") });
    }
    if (parentsInFile.has(sku ?? "") && ex && !ex.hasVariants && stocked.has(ex.id)) errors.push({ field: "sku", message: msg("variants.errors.parentHasStock", { product: sku!, productAr: sku! }) });
    if (errors.length || !parsedInput.success) {
      results.push({ sheet: "products", row: r.row, sku, name, action: "error", messages: errors });
      continue;
    }
    const d = parsedInput.data;
    products.push({
      kind: "product",
      row: r.row,
      existingId: ex?.id ?? null,
      serialMode,
      generateBarcode,
      newBrand,
      newCategory,
      data: {
        sku: d.sku,
        barcode: d.barcode,
        nameEn: d.nameEn,
        nameAr: d.nameAr,
        categoryId,
        brandId,
        model: d.model,
        description: d.description,
        unitId,
        purchaseCost: d.purchaseCost,
        sellingPrice: d.sellingPrice,
        minStock: d.minStock,
        warrantyMonths: d.warrantyMonths,
        isActive: d.isActive,
        createdById: user.id,
      },
    });
    if (sku) fileProducts.set(sku, { serialMode, isVariantParent: parentsInFile.has(sku) });
    results.push({ sheet: "products", row: r.row, sku, name, action: ex ? "update" : "create", messages: [] });
  }

  // A variant row without a code gets the code the commit will generate (PARENT-BLACK, ...), so the
  // preview shows it and the stock sheet can name it.
  const needCode = variantRows.filter((r) => !(normalizeCode(r.v.sku ?? "") as string) && r.v.variant_en);
  const candidatesOf = (r: Rows[number]) => variantCodeCandidates(normalizeCode(r.v.parent_sku) as string, r.v.variant_en, 8);
  const candidates = [...new Set(needCode.flatMap(candidatesOf))];
  const givenCodes = parsed.products.map((r) => normalizeCode(r.v.sku ?? "") as string).filter(Boolean);
  const taken = new Set([...givenCodes, ...(candidates.length ? (await db.product.findMany({ where: { sku: { in: candidates } }, select: { sku: true } })).map((p) => p.sku) : [])]);
  const predicted = new Map<number, string>();
  for (const r of needCode) {
    const c = candidatesOf(r).find((x) => !taken.has(x));
    if (c) {
      predicted.set(r.row, c);
      taken.add(c);
    }
  }

  for (const r of variantRows) {
    const v = r.v;
    const errors: RowMessage[] = [];
    const sku = (normalizeCode(v.sku ?? "") as string) || predicted.get(r.row) || null;
    const parentSku = normalizeCode(v.parent_sku) as string;
    const ex = sku ? existingBy.get(sku) : undefined;
    const name = v.variant_en || v.variant_ar || null;
    if (ex && !opts.update) {
      results.push({ sheet: "products", row: r.row, sku, name, action: "skip", messages: [{ field: "sku", message: msg("productImport.errors.exists") }] });
      continue;
    }
    const parentDb = existingBy.get(parentSku);
    const parentFile = fileProducts.get(parentSku);
    if (!parentDb && !parentFile) errors.push({ field: "parent_sku", message: msg("productImport.errors.parentMissing", { sku: parentSku }) });
    if (parentDb?.parentId) errors.push({ field: "parent_sku", message: msg("productImport.errors.parentIsVariant", { sku: parentSku }) });
    if (parentDb && !parentDb.hasVariants && !parentFile && stocked.has(parentDb.id)) errors.push({ field: "parent_sku", message: msg("variants.errors.parentHasStock", { product: parentSku, productAr: parentSku }) });
    if (ex && ex.parent?.sku !== parentSku) errors.push({ field: "parent_sku", message: msg("productImport.errors.noUpdateVariantParent") });
    const generateBarcode = yesNo(v.generate_barcode, "generate_barcode", errors, false);
    const isActive = yesNo(v.active, "active", errors, true);
    const parsedInput = variantSchema.safeParse({
      sku,
      barcode: v.barcode,
      variantNameEn: v.variant_en,
      variantNameAr: v.variant_ar,
      colorHex: v.color ? (v.color.startsWith("#") ? v.color : `#${v.color}`) : null,
      purchaseCost: numberOrBlank(v.purchase_cost ?? ""),
      sellingPrice: numberOrBlank(v.selling_price ?? ""),
      minStock: numberOrBlank(v.min_stock ?? ""),
      isActive,
    });
    if (!parsedInput.success) errors.push(...zodErrors(parsedInput.error));
    noteDuplicates(sku, parsedInput.success ? parsedInput.data.barcode : null, r.row, errors, ex?.id ?? null);
    if (errors.length || !parsedInput.success) {
      results.push({ sheet: "products", row: r.row, sku, name, action: "error", messages: errors });
      continue;
    }
    const d = parsedInput.data;
    variants.push({ kind: "variant", row: r.row, existingId: ex?.id ?? null, parentSku, sku: d.sku, barcode: d.barcode, generateBarcode, variantNameEn: d.variantNameEn, variantNameAr: d.variantNameAr, colorHex: d.colorHex, purchaseCost: d.purchaseCost, sellingPrice: d.sellingPrice, minStock: d.minStock, isActive: d.isActive });
    if (sku) fileVariants.set(sku, { serialMode: parentFile?.serialMode ?? (parentDb ? serialModeOf(parentDb) : null), parentSku });
    results.push({ sheet: "products", row: r.row, sku, name, action: ex ? "update" : "create", messages: [] });
  }

  // Opening stock: drafts only, and only for someone who may prepare opening balances.
  const stock: StockPlan[] = [];
  const mayOpen = hasPermission(user, "inventory.approve");
  const seenSerial = new Map<string, number>();
  for (const r of parsed.stock) {
    const v = r.v;
    const errors: RowMessage[] = [];
    const sku = (normalizeCode(v.sku ?? "") as string) || null;
    if (!mayOpen) errors.push({ field: null, message: msg("productImport.errors.openingNeedsApproval") });
    const ex = sku ? existingBy.get(sku) : undefined;
    const fileP = sku ? fileProducts.get(sku) : undefined;
    const fileV = sku ? fileVariants.get(sku) : undefined;
    if (!sku) errors.push({ field: "sku", message: msg("validation.required", { field: "@catalog.products.sku" }) });
    else if (!ex && !fileP && !fileV) errors.push({ field: "sku", message: msg("productImport.errors.unknownSku", { value: sku }) });
    else if (ex?.hasVariants || fileP?.isVariantParent) errors.push({ field: "sku", message: msg("productImport.errors.stockForParent", { sku }) });
    const w = whBy.get((normalizeCode(v.warehouse ?? "") as string) || "");
    if (!w) errors.push({ field: "warehouse", message: msg("productImport.errors.unknownWarehouse", { value: v.warehouse || "—" }) });
    const binCode = (normalizeCode(v.bin ?? "") as string) || null;
    const bin = binCode && w ? w.bins.find((b) => b.code === binCode) : null;
    if (binCode && w && !bin) errors.push({ field: "bin", message: msg("productImport.errors.unknownBin", { value: binCode, warehouse: w.code }) });
    const qty = Number(numberOrBlank(v.quantity ?? ""));
    if (!(qty > 0) || !Number.isFinite(qty)) errors.push({ field: "quantity", message: msg("stock.errors.quantity") });
    const cost = v.unit_cost ? Number(numberOrBlank(v.unit_cost)) : null;
    if (cost !== null && !(cost >= 0)) errors.push({ field: "unit_cost", message: msg("validation.amount") });
    const serials = splitSerials(v.serials ?? "");
    const mode = ex ? serialModeOf(ex) : (fileP?.serialMode ?? fileV?.serialMode ?? "NONE");
    if (mode === "REQUIRED" && serials.length !== qty) errors.push({ field: "serials", message: msg("stock.errors.serialCount", { count: qty, given: serials.length }) });
    if (mode === "OPTIONAL" && serials.length > qty) errors.push({ field: "serials", message: msg("serialModes.tooManySerials", { count: qty, given: serials.length }) });
    if (mode === "NONE" && serials.length) errors.push({ field: "serials", message: msg("stock.errors.noSerials") });
    for (const s of serials) {
      const k = `${sku}|${s}`;
      if (seenSerial.has(k)) errors.push({ field: "serials", message: msg("stock.errors.serialTwice", { list: s }) });
      seenSerial.set(k, r.row);
    }
    if (errors.length) {
      results.push({ sheet: "stock", row: r.row, sku, name: v.warehouse || null, action: "error", messages: errors });
      continue;
    }
    stock.push({ row: r.row, sku: sku!, warehouseId: w!.id, warehouseCode: w!.code, binId: bin?.id ?? null, quantity: qty, unitCost: cost, serials });
    results.push({ sheet: "stock", row: r.row, sku, name: w!.code, action: "create", messages: [] });
  }
  results.sort((a, b) => (a.sheet === b.sheet ? a.row - b.row : a.sheet === "products" ? -1 : 1));
  return { results, products, variants, stock };
}

function countsOf(rows: RowResult[]): Record<RowAction, number> {
  const c: Record<RowAction, number> = { create: 0, update: 0, skip: 0, error: 0 };
  for (const r of rows) c[r.action]++;
  return c;
}

export async function previewImport(user: CurrentUser, bytes: Uint8Array | null, opts: ImportOptions): Promise<ImportResult> {
  assertCan(user, "products.manage");
  const parsed = await readWorkbook(bytes);
  const p = await plan(prisma, user, parsed, opts);
  return { committed: false, rows: p.results, counts: countsOf(p.results), openingDocuments: [] };
}

const IMPORT_TX = { timeout: 300_000, maxWait: 20_000 };

/** Validates again and writes everything in one transaction (or nothing, see ImportOptions). */
export async function commitImport(user: CurrentUser, bytes: Uint8Array | null, opts: ImportOptions, now = new Date()): Promise<ImportResult> {
  assertCan(user, "products.manage");
  const parsed = await readWorkbook(bytes);
  return prisma.$transaction(async (tx) => {
    // One import at a time, so two people importing the same file cannot both create its rows.
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended('import:products', 0))`;
    const p = await plan(tx, user, parsed, opts);
    const counts = countsOf(p.results);
    if (counts.error && !opts.skipInvalid) return { committed: false, rows: p.results, counts, openingDocuments: [] };

    const audits: Prisma.AuditLogCreateManyInput[] = [];
    const audit = (entityId: string, action: string, summary: string, changes: Record<string, unknown>) =>
      audits.push({ entityType: "PRODUCT", entityId, action, summary: createT("en").msg(summary).slice(0, 500), summaryData: messageData(summary) ?? Prisma.DbNull, changes: changes as Prisma.InputJsonValue, actorId: user.id, createdAt: now });
    const reservedSku = new Set<string>();
    const reservedBarcode = new Set<string>();
    const idBySku = new Map<string, { id: string; sku: string; nameEn: string; nameAr: string }>();
    const resultByRow = new Map(p.results.filter((r) => r.sheet === "products").map((r) => [r.row, r]));

    // Brands and categories to create (once each).
    const brandIds = new Map<string, string>();
    const categoryIds = new Map<string, string>();
    for (const pp of p.products) {
      if (pp.newBrand && !brandIds.has(foldText(pp.newBrand))) {
        const b = await tx.brand.create({ data: { name: pp.newBrand } });
        brandIds.set(foldText(pp.newBrand), b.id);
      }
      if (pp.newCategory) {
        const key = foldText(`${pp.newCategory.parent ?? ""}>${pp.newCategory.name}`);
        if (!categoryIds.has(key)) {
          let parentId = pp.newCategory.parent;
          if (parentId && !(await tx.catalogCategory.findUnique({ where: { id: parentId }, select: { id: true } }))) {
            const pk = foldText(`>${parentId}`);
            parentId = categoryIds.get(pk) ?? (await tx.catalogCategory.create({ data: { nameEn: parentId, nameAr: parentId } })).id;
            categoryIds.set(pk, parentId);
          }
          categoryIds.set(key, (await tx.catalogCategory.create({ data: { nameEn: pp.newCategory.name, nameAr: pp.newCategory.name, parentId } })).id);
        }
      }
    }

    // New products: codes and barcodes reserved per block, rows inserted in batches. Codes typed
    // in the file are reserved first, so a generated block never hands one of them out again.
    for (const x of [...p.products.map((pp) => pp.data.sku), ...p.variants.map((vp) => vp.sku)]) if (x) reservedSku.add(x);
    for (const x of [...p.products.map((pp) => pp.data.barcode), ...p.variants.map((vp) => vp.barcode)]) if (x) reservedBarcode.add(x as string);
    const fresh = p.products.filter((pp) => !pp.existingId);
    const prefixOf = new Map<string | null, string>();
    for (const pp of fresh) {
      if (pp.newBrand) pp.data.brandId = brandIds.get(foldText(pp.newBrand))!;
      if (pp.newCategory) pp.data.categoryId = categoryIds.get(foldText(`${pp.newCategory.parent ?? ""}>${pp.newCategory.name}`))!;
      const cat = (pp.data.categoryId as string | null) ?? null;
      if (!pp.data.sku && !prefixOf.has(cat)) prefixOf.set(cat, await skuPrefix(tx, cat));
    }
    for (const prefix of new Set(prefixOf.values())) {
      const need = fresh.filter((pp) => !pp.data.sku && prefixOf.get((pp.data.categoryId as string | null) ?? null) === prefix);
      const codes = await reserveSkus(tx, prefix, need.length, reservedSku);
      need.forEach((pp, i) => (pp.data.sku = codes[i]!));
    }
    const needBarcode = fresh.filter((pp) => !pp.data.barcode && pp.generateBarcode);
    const barcodes = await reserveBarcodes(tx, needBarcode.length, reservedBarcode);
    needBarcode.forEach((pp, i) => (pp.data.barcode = barcodes[i]!));
    for (let i = 0; i < fresh.length; i += 500) {
      const chunk = fresh.slice(i, i + 500);
      const made = await tx.product.createManyAndReturn({
        data: chunk.map((pp) => ({ ...pp.data, ...serialFlags(pp.serialMode), sku: pp.data.sku!, hasVariants: false })),
        select: { id: true, sku: true, nameEn: true, nameAr: true },
      });
      const bySku = new Map(made.map((m) => [m.sku, m]));
      for (const pp of chunk) {
        const row = bySku.get(pp.data.sku!)!;
        idBySku.set(row.sku, row);
        audit(row.id, "PRODUCT_CREATED", msg("audit.productCreated", { name: user.name, sku: row.sku, product: row.nameEn, productAr: row.nameAr }), { import: true, row: pp.row, sku: row.sku });
        resultByRow.get(pp.row)!.sku = row.sku;
      }
    }

    for (const pp of p.products.filter((x) => x.existingId)) {
      const d = { ...pp.data, ...serialFlags(pp.serialMode) };
      if (pp.newBrand) d.brandId = brandIds.get(foldText(pp.newBrand))!;
      if (pp.newCategory) d.categoryId = categoryIds.get(foldText(`${pp.newCategory.parent ?? ""}>${pp.newCategory.name}`))!;
      const { createdById: _c, sku, ...upd } = d;
      void _c;
      const before = await tx.product.findUniqueOrThrow({ where: { id: pp.existingId! } });
      const row = await tx.product.update({
        where: { id: pp.existingId! },
        data: { ...upd, sku: sku ?? before.sku, barcode: upd.barcode ?? before.barcode ?? (pp.generateBarcode ? await nextInternalBarcode(tx, reservedBarcode) : null), updatedById: user.id, version: { increment: 1 } },
      });
      if (row.hasVariants) {
        for (const v of await tx.product.findMany({ where: { parentId: row.id }, select: { id: true, variantNameEn: true, variantNameAr: true } })) {
          await tx.product.update({ where: { id: v.id }, data: { ...sharedOf(row), ...variantFullName(row, { variantNameEn: v.variantNameEn!, variantNameAr: v.variantNameAr! }), updatedById: user.id, version: { increment: 1 } } });
        }
      }
      idBySku.set(row.sku, row);
      audit(row.id, "PRODUCT_UPDATED", msg("audit.productUpdated", { name: user.name, sku: row.sku, product: row.nameEn, productAr: row.nameAr }), { import: true, row: pp.row });
      resultByRow.get(pp.row)!.sku = row.sku;
    }

    for (const vp of p.variants) {
      const parent = await tx.product.findUniqueOrThrow({ where: { sku: vp.parentSku } });
      if (!parent.hasVariants) await tx.product.update({ where: { id: parent.id }, data: { hasVariants: true, updatedById: user.id, version: { increment: 1 } } });
      if (vp.existingId) {
        const before = await tx.product.findUniqueOrThrow({ where: { id: vp.existingId } });
        const row = await tx.product.update({
          where: { id: vp.existingId },
          data: {
            ...variantFullName(parent, vp),
            sku: vp.sku ?? before.sku,
            barcode: vp.barcode ?? before.barcode ?? (vp.generateBarcode ? await nextInternalBarcode(tx, reservedBarcode) : null),
            variantNameEn: vp.variantNameEn,
            variantNameAr: vp.variantNameAr,
            colorHex: vp.colorHex,
            purchaseCost: vp.purchaseCost,
            sellingPrice: vp.sellingPrice,
            minStock: vp.minStock,
            isActive: vp.isActive,
            updatedById: user.id,
            version: { increment: 1 },
          },
        });
        idBySku.set(row.sku, row);
        audit(row.id, "VARIANT_UPDATED", msg("erpAudit.variantUpdated", { name: user.name, sku: row.sku, product: parent.nameEn, productAr: parent.nameAr, variant: vp.variantNameEn, variantAr: vp.variantNameAr }), { import: true, row: vp.row });
        resultByRow.get(vp.row)!.sku = row.sku;
      } else {
        const sku = vp.sku ?? (await nextVariantCode(tx, parent.sku, vp.variantNameEn, reservedSku));
        reservedSku.add(sku);
        const row = await tx.product.create({
          data: {
            ...sharedOf(parent),
            ...variantFullName(parent, vp),
            sku,
            barcode: vp.barcode ?? (vp.generateBarcode ? await nextInternalBarcode(tx, reservedBarcode) : null),
            parentId: parent.id,
            variantNameEn: vp.variantNameEn,
            variantNameAr: vp.variantNameAr,
            colorHex: vp.colorHex,
            purchaseCost: vp.purchaseCost ?? parent.purchaseCost,
            sellingPrice: vp.sellingPrice ?? parent.sellingPrice,
            minStock: vp.minStock,
            isActive: vp.isActive,
            createdById: user.id,
          },
        });
        idBySku.set(row.sku, row);
        audit(row.id, "VARIANT_CREATED", msg("erpAudit.variantCreated", { name: user.name, sku: row.sku, product: parent.nameEn, productAr: parent.nameAr, variant: vp.variantNameEn, variantAr: vp.variantNameAr }), { import: true, row: vp.row, parentId: parent.id });
        resultByRow.get(vp.row)!.sku = row.sku;
      }
    }

    // Opening stock: one draft per warehouse (200 lines at most per document).
    const openingDocuments: ImportResult["openingDocuments"] = [];
    const byWarehouse = new Map<string, StockPlan[]>();
    for (const s of p.stock) byWarehouse.set(s.warehouseId, [...(byWarehouse.get(s.warehouseId) ?? []), s]);
    const dateKey = today(user, now);
    const year = Number(dateKey.slice(0, 4));
    for (const [warehouseId, lines] of byWarehouse) {
      for (let i = 0; i < lines.length; i += 200) {
        const chunk = lines.slice(i, i + 200);
        const ids = await Promise.all(chunk.map(async (l) => idBySku.get(l.sku) ?? (await tx.product.findUniqueOrThrow({ where: { sku: l.sku }, select: { id: true, sku: true, nameEn: true, nameAr: true } }))));
        const number = formatDocNumber(DOC_PREFIX.OPENING, year, await nextSequence(tx, `${DOC_PREFIX.OPENING}-${year}`));
        const doc = await tx.stockDocument.create({
          data: {
            number,
            type: "OPENING",
            toWarehouseId: warehouseId,
            documentDate: new Date(`${dateKey}T00:00:00.000Z`),
            note: msg("productImport.sheetStock"),
            createdById: user.id,
            createdAt: now,
            lines: { create: chunk.map((l, n) => ({ lineNo: n + 1, productId: ids[n]!.id, quantity: l.quantity, unitCost: l.unitCost, toBinId: l.binId, serials: l.serials })) },
          },
        });
        audits.push({
          entityType: "INVENTORY",
          entityId: doc.id,
          action: "STOCK_DOC_CREATED",
          summary: createT("en").msg(msg("audit.stockDocCreated", { name: user.name, number, type: "@enums.stockDocType.OPENING" })),
          summaryData: messageData(msg("audit.stockDocCreated", { name: user.name, number, type: "@enums.stockDocType.OPENING" })) ?? Prisma.DbNull,
          changes: { number, lines: chunk.length, import: true },
          actorId: user.id,
          createdAt: now,
        });
        openingDocuments.push({ id: doc.id, number, warehouse: chunk[0]!.warehouseCode });
      }
    }
    const done = countsOf(p.results);
    const summary = msg("erpAudit.productsImported", { created: done.create, updated: done.update, skipped: done.skip + done.error });
    audits.push({ entityType: "PRODUCT", entityId: "import", action: "PRODUCTS_IMPORTED", summary: createT("en").msg(summary), summaryData: messageData(summary) ?? Prisma.DbNull, changes: { ...done, opening: openingDocuments.map((d) => d.number) }, actorId: user.id, createdAt: now });
    for (let i = 0; i < audits.length; i += 1000) await tx.auditLog.createMany({ data: audits.slice(i, i + 1000) });
    return { committed: true, rows: p.results, counts: done, openingDocuments };
  }, IMPORT_TX);
}

// ---- Writing workbooks -------------------------------------------------------------------------

function styleHeader(ws: ExcelJS.Worksheet, columns: ImportColumn[]) {
  ws.columns = columns.map((c) => ({ header: headerOf(c), key: c.key, width: Math.max(14, Math.min(40, headerOf(c).length + 4)) }));
  const head = ws.getRow(1);
  head.font = { bold: true, color: { argb: "FFFFFFFF" } };
  head.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFC44617" } };
  head.alignment = { vertical: "middle", wrapText: true };
  head.height = 32;
  ws.views = [{ state: "frozen", ySplit: 1 }];
  columns.forEach((c, i) => {
    ws.getColumn(i + 1).numFmt = "@"; // text, so codes and barcodes keep their leading zeros
    head.getCell(i + 1).note = `${c.hintEn}\n${c.hintAr}`;
  });
}

function instructionsSheet(wb: ExcelJS.Workbook) {
  const ws = wb.addWorksheet("Instructions - التعليمات");
  ws.columns = [{ width: 26 }, { width: 70 }, { width: 70 }];
  ws.addRow(["Column / العمود", "English", "العربية"]).font = { bold: true };
  for (const c of [...PRODUCT_COLUMNS]) ws.addRow([headerOf(c), `${c.required ? "* " : ""}${c.hintEn}`, `${c.required ? "* " : ""}${c.hintAr}`]);
  ws.addRow([]);
  ws.addRow([`${STOCK_SHEET.en} / ${STOCK_SHEET.ar}`, "Optional. Each row becomes a line of a DRAFT opening-balance document per warehouse; a warehouse manager reviews and posts it.", "اختياري. كل صف يصبح سطرًا في مسودة رصيد افتتاحي لكل مخزن؛ يراجعها مدير المخزن ويرحّلها."]).font = { bold: true };
  for (const c of STOCK_COLUMNS) ws.addRow([headerOf(c), `${c.required ? "* " : ""}${c.hintEn}`, `${c.required ? "* " : ""}${c.hintAr}`]);
  ws.addRow([]);
  ws.addRow(["", "A row with Parent SKU is a variant (colour or configuration) of that product. Rows with an existing SKU update the product when updates are allowed.", "الصف الذي فيه كود الصنف الأب هو نوع (لون أو تكوين) من ذلك الصنف. الصفوف بكود موجود تحدّث الصنف إذا سُمح بالتحديث."]);
  ws.getColumn(2).alignment = { wrapText: true, vertical: "top" };
  ws.getColumn(3).alignment = { wrapText: true, vertical: "top", readingOrder: "rtl" };
}

async function toBuffer(wb: ExcelJS.Workbook): Promise<Buffer> {
  return Buffer.from(await wb.xlsx.writeBuffer());
}

export async function importTemplate(user: CurrentUser): Promise<Buffer> {
  assertCan(user, "products.manage");
  const wb = new ExcelJS.Workbook();
  wb.creator = "Installation Manager System";
  const ws = wb.addWorksheet(PRODUCTS_SHEET.en);
  styleHeader(ws, PRODUCT_COLUMNS);
  ws.addRow({ sku: "", name_en: "Smart Lock Model Y", name_ar: "قفل ذكي موديل Y", category: "Smart locks", brand: "Yale", model: "Y1", unit: "PCS", purchase_cost: "3500", selling_price: "4900", min_stock: "2", warranty_months: "24", serial_mode: "REQUIRED", generate_barcode: "no", active: "yes" });
  ws.addRow({ parent_sku: "(SKU of the row above / كود الصف السابق)", variant_en: "Black", variant_ar: "أسود", color: "#1F1F1F", selling_price: "4900" });
  ws.addRow({ sku: "CBL-ALARM-4", name_en: "Alarm cable 4 core", name_ar: "كابل إنذار 4 خط", category: "Cables & accessories", unit: "M", purchase_cost: "6", selling_price: "10", min_stock: "200", serial_mode: "NONE" });
  for (const r of [2, 3, 4]) ws.getRow(r).font = { italic: true, color: { argb: "FF6B7280" } };
  const st = wb.addWorksheet(STOCK_SHEET.en);
  styleHeader(st, STOCK_COLUMNS);
  st.addRow({ sku: "CBL-ALARM-4", warehouse: "MAIN", bin: "", quantity: "500", unit_cost: "6", serials: "" });
  st.getRow(2).font = { italic: true, color: { argb: "FF6B7280" } };
  instructionsSheet(wb);
  return toBuffer(wb);
}

/** Every product and variant in the import columns (export, edit, import again to update). */
export async function exportProductsXlsx(user: CurrentUser): Promise<Buffer> {
  assertCan(user, "products.view");
  assertCan(user, "products.export");
  const costs = canSeeCosts(user);
  const [rows, onHand] = await Promise.all([
    prisma.product.findMany({
      orderBy: [{ sku: "asc" }],
      select: {
        id: true, sku: true, barcode: true, nameEn: true, nameAr: true, parentId: true, hasVariants: true, variantNameEn: true, variantNameAr: true, colorHex: true,
        model: true, description: true, purchaseCost: true, sellingPrice: true, minStock: true, warrantyMonths: true, trackSerials: true, serialsOptional: true, isActive: true,
        unit: { select: { code: true } }, brand: { select: { name: true } }, parent: { select: { sku: true } },
        category: { select: { code: true, nameEn: true, parent: { select: { nameEn: true } } } },
      },
    }),
    prisma.stockBalance.groupBy({ by: ["productId"], _sum: { quantity: true } }),
  ]);
  const qty = new Map(onHand.map((o) => [o.productId, num(o._sum.quantity)]));
  const children = new Map<string, typeof rows>();
  for (const r of rows) if (r.parentId) children.set(r.parentId, [...(children.get(r.parentId) ?? []), r]);
  const wb = new ExcelJS.Workbook();
  wb.creator = "Installation Manager System";
  const ws = wb.addWorksheet(PRODUCTS_SHEET.en);
  const extra: ImportColumn = { key: "on_hand", en: "On hand (not imported)", ar: "الرصيد (لا يُستورد)", hintEn: "Information only.", hintAr: "للمعلومة فقط." };
  styleHeader(ws, [...PRODUCT_COLUMNS, extra]);
  const add = (r: (typeof rows)[number]) => {
    const variant = !!r.parentId;
    ws.addRow({
      sku: r.sku,
      parent_sku: r.parent?.sku ?? "",
      name_en: variant ? "" : r.nameEn,
      name_ar: variant ? "" : r.nameAr,
      variant_en: r.variantNameEn ?? "",
      variant_ar: r.variantNameAr ?? "",
      color: r.colorHex ?? "",
      category: variant ? "" : (r.category ? (r.category.code ?? (r.category.parent ? `${r.category.parent.nameEn} > ${r.category.nameEn}` : r.category.nameEn)) : ""),
      brand: variant ? "" : (r.brand?.name ?? ""),
      model: variant ? "" : (r.model ?? ""),
      unit: variant ? "" : r.unit.code,
      purchase_cost: costs && r.purchaseCost !== null ? String(numOrNull(r.purchaseCost)) : "",
      selling_price: r.sellingPrice !== null ? String(numOrNull(r.sellingPrice)) : "",
      min_stock: String(num(r.minStock)),
      warranty_months: variant ? "" : String(r.warrantyMonths),
      serial_mode: variant ? "" : serialModeOf(r),
      barcode: r.barcode ?? "",
      generate_barcode: "",
      description: variant ? "" : (r.description ?? ""),
      active: r.isActive ? "yes" : "no",
      on_hand: String(r.hasVariants ? (children.get(r.id) ?? []).reduce((s, c) => s + (qty.get(c.id) ?? 0), 0) : (qty.get(r.id) ?? 0)),
    });
  };
  for (const r of rows) {
    if (r.parentId) continue;
    add(r);
    for (const c of children.get(r.id) ?? []) add(c);
  }
  instructionsSheet(wb);
  return toBuffer(wb);
}

export function xlsxResponse(buffer: Buffer, filename: string): Response {
  return new Response(new Uint8Array(buffer), {
    headers: {
      "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "Content-Disposition": `attachment; filename="${filename}"`,
      "Cache-Control": "no-store",
    },
  });
}

export const importErrors = { hasErrors: (count: number) => msg("productImport.errors.hasErrors", { count }) };
