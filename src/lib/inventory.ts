/**
 * ERP inventory: shared rules and input schemas (browser for instant feedback, server for the
 * authoritative check). Pure: no database access.
 */
import { z } from "zod";
import type { AdjustDirection, InventoryMovementType, StockDocStatus, StockDocType, StockReturnKind, StocktakeStatus, WarehouseKind } from "@prisma/client";
import { intlLocale, type Locale } from "@/i18n/config";
import { msg } from "@/i18n/translator";
import type { Permission } from "./permissions";
import { isValidDateString } from "./time";
import { parseSerials, SERIAL_RE } from "./constants";
import { optionalText } from "./validation";
import { CATEGORY_CODE_RE, normalizeCategoryCode } from "./product-codes";

export const STOCK_DOC_TYPES: StockDocType[] = ["RECEIPT", "ISSUE", "TRANSFER", "RETURN", "ADJUSTMENT", "OPENING"];
export const STOCK_DOC_STATUSES: StockDocStatus[] = ["DRAFT", "POSTED", "CANCELLED"];
export const RETURN_KINDS: StockReturnKind[] = ["CUSTOMER", "SUPPLIER"];
export const ADJUST_DIRECTIONS: AdjustDirection[] = ["INCREASE", "DECREASE"];
export const WAREHOUSE_KINDS: WarehouseKind[] = ["WAREHOUSE", "VEHICLE"];
export const STOCKTAKE_STATUSES: StocktakeStatus[] = ["COUNTING", "SUBMITTED", "APPROVED", "REJECTED", "CANCELLED"];
export const MOVEMENT_TYPES: InventoryMovementType[] = [
  "OPENING_BALANCE",
  "GOODS_RECEIPT",
  "ISSUE",
  "TRANSFER_OUT",
  "TRANSFER_IN",
  "CUSTOMER_RETURN",
  "SUPPLIER_RETURN",
  "ADJUSTMENT_INCREASE",
  "ADJUSTMENT_DECREASE",
  "REVERSAL",
];

/** Document number prefixes: GRN-2026-000001. */
export const DOC_PREFIX: Record<StockDocType, string> = {
  OPENING: "OB",
  RECEIPT: "GRN",
  ISSUE: "ISS",
  TRANSFER: "TRF",
  RETURN: "RTN",
  ADJUSTMENT: "ADJ",
};
export const STOCKTAKE_PREFIX = "STK";

export function formatDocNumber(prefix: string, year: number, n: number): string {
  return `${prefix}-${year}-${String(n).padStart(6, "0")}`;
}

/**
 * Who may prepare (create / edit the draft) and who may post each kind of document. Opening
 * balances and adjustments change stock without goods physically arriving or leaving, so posting
 * them needs the approval permission.
 */
export function docPermissions(type: StockDocType, returnKind: StockReturnKind | null | undefined): { prepare: Permission; post: Permission } {
  switch (type) {
    case "OPENING":
      return { prepare: "inventory.approve", post: "inventory.approve" };
    case "RECEIPT":
      return { prepare: "inventory.receive", post: "inventory.receive" };
    case "ISSUE":
      return { prepare: "inventory.issue", post: "inventory.issue" };
    case "TRANSFER":
      return { prepare: "inventory.transfer", post: "inventory.transfer" };
    case "RETURN":
      return returnKind === "SUPPLIER" ? { prepare: "inventory.issue", post: "inventory.issue" } : { prepare: "inventory.receive", post: "inventory.receive" };
    case "ADJUSTMENT":
      return { prepare: "inventory.count", post: "inventory.approve" };
  }
}

/** Which warehouses a document uses (the same rule as the stock_documents_warehouses_check constraint). */
export function docWarehouseSides(type: StockDocType, returnKind: StockReturnKind | null | undefined): { from: boolean; to: boolean } {
  if (type === "ISSUE" || (type === "RETURN" && returnKind === "SUPPLIER")) return { from: true, to: false };
  if (type === "TRANSFER") return { from: true, to: true };
  return { from: false, to: true };
}

/** Whether a line brings stock in at a cost (the cost then feeds the moving average). */
export function lineTakesCost(type: StockDocType, returnKind: StockReturnKind | null | undefined, direction: AdjustDirection | null | undefined): boolean {
  if (type === "OPENING" || type === "RECEIPT") return true;
  if (type === "RETURN") return returnKind !== "SUPPLIER";
  if (type === "ADJUSTMENT") return direction === "INCREASE";
  return false;
}

/** Upper-case, without spaces (SKUs, barcodes, warehouse / bin / unit codes). */
export function normalizeCode(raw: unknown): unknown {
  return typeof raw === "string" ? raw.replace(/\s+/g, "").toUpperCase() : raw;
}

export const SKU_RE = /^[A-Z0-9][A-Z0-9._/-]{0,63}$/;
export const BARCODE_RE = /^[0-9A-Z._-]{1,64}$/;
export const LOCATION_CODE_RE = /^[A-Z0-9][A-Z0-9_-]{0,19}$/;
export const UNIT_CODE_RE = /^[A-Z0-9][A-Z0-9_-]{0,15}$/;

/** Whole or up to three decimals (meters of cable, ...). */
export function hasAtMostDecimals(n: number, places: number): boolean {
  const f = 10 ** places;
  return Math.abs(n * f - Math.round(n * f)) < 1e-6;
}

/** Quantities are shown without trailing zeros: 3, 2.5, 0.125. */
const qtyFormats = new Map<string, Intl.NumberFormat>();
export function formatQuantity(n: number, locale: Locale): string {
  let f = qtyFormats.get(locale);
  if (!f) qtyFormats.set(locale, (f = new Intl.NumberFormat(intlLocale(locale), { maximumFractionDigits: 3 })));
  return f.format(n);
}

const required = (label: string) => msg("validation.required", { field: `@${label}` });
const maxChars = (max: number) => msg("validation.maxChars", { max });

const requiredText = (label: string, max: number) =>
  z.preprocess((v) => (typeof v === "string" ? v.trim() : v), z.string({ error: required(label) }).min(1, required(label)).max(max, maxChars(max)));

const optionalId = z.preprocess((v) => (v === "" || v === undefined ? null : v), z.string().min(1).max(64).nullable());
const requiredId = (label: string) => z.preprocess((v) => (v === "" ? undefined : v), z.string({ error: required(label) }).min(1).max(64));

const toNumber = (v: unknown) => (typeof v === "string" ? (v.trim() === "" ? undefined : Number(v.replace(/[,\s]/g, ""))) : v);

/** A quantity greater than zero with at most three decimals. */
export const quantityField = z.preprocess(
  toNumber,
  z
    .number({ error: msg("stock.errors.quantity") })
    .positive(msg("stock.errors.quantity"))
    .max(1_000_000_000, msg("validation.tooLarge"))
    .refine((n) => hasAtMostDecimals(n, 3), msg("stock.errors.threeDecimals")),
);

/** A count: zero or more, at most three decimals. */
export const countField = z.preprocess(
  toNumber,
  z
    .number({ error: msg("stock.errors.count") })
    .min(0, msg("validation.negative"))
    .max(1_000_000_000, msg("validation.tooLarge"))
    .refine((n) => hasAtMostDecimals(n, 3), msg("stock.errors.threeDecimals")),
);

/** Money: blank = not set; at most `places` decimals. */
const moneyField = (places: number) =>
  z.preprocess(
    (v) => (v === "" || v === null || v === undefined ? null : toNumber(v)),
    z
      .number({ error: msg("validation.amount") })
      .min(0, msg("validation.negative"))
      .max(10_000_000, msg("validation.tooLarge"))
      .refine((n) => hasAtMostDecimals(n, places), places === 2 ? msg("validation.twoDecimals") : msg("stock.errors.fourDecimals"))
      .nullable(),
  );

const boolField = (def: boolean) => z.preprocess((v) => (v === "true" || v === "on" ? true : v === "false" ? false : (v ?? def)), z.boolean());
const versionField = z.preprocess(toNumber, z.number().int().min(1).optional());

const serialList = z.preprocess(
  (v) => (Array.isArray(v) ? parseSerials(v.join("\n")) : typeof v === "string" ? parseSerials(v) : (v ?? [])),
  z
    .array(z.string())
    .max(1000, msg("stock.errors.maxSerials"))
    .superRefine((list, ctx) => {
      const bad = list.filter((s) => !SERIAL_RE.test(s));
      if (bad.length) ctx.addIssue({ code: "custom", message: msg("validation.badSerial", { list: bad.slice(0, 5).join(", ") }) });
    }),
);

// ---- Catalogue -------------------------------------------------------------------------------

export const unitSchema = z.object({
  code: z.preprocess(normalizeCode, z.string({ error: required("catalog.units.code") }).regex(UNIT_CODE_RE, msg("catalog.errors.unitCode"))),
  nameEn: requiredText("catalog.nameEn", 60),
  nameAr: requiredText("catalog.nameAr", 60),
  allowsFraction: boolField(false),
  isActive: boolField(true),
  sortOrder: z.preprocess((v) => toNumber(v) ?? 0, z.number().int().min(0).max(10_000)),
});

export const categorySchema = z.object({
  /** Optional SKU prefix; left out = unchanged on an edit. */
  code: z.preprocess(normalizeCategoryCode, z.string().regex(CATEGORY_CODE_RE, msg("variants.errors.categoryCode")).nullable().optional()),
  nameEn: requiredText("catalog.nameEn", 100),
  nameAr: requiredText("catalog.nameAr", 100),
  parentId: optionalId,
  isActive: boolField(true),
  sortOrder: z.preprocess((v) => toNumber(v) ?? 0, z.number().int().min(0).max(10_000)),
});

export const brandSchema = z.object({
  name: requiredText("catalog.brands.name", 100),
  isActive: boolField(true),
});

/** How serial numbers are kept: none, when known (optional), or one per unit (mandatory). */
export const SERIAL_MODES = ["NONE", "OPTIONAL", "REQUIRED"] as const;
export type SerialMode = (typeof SERIAL_MODES)[number];
export function serialModeOf(p: { trackSerials: boolean; serialsOptional?: boolean | null }): SerialMode {
  return p.trackSerials ? "REQUIRED" : p.serialsOptional ? "OPTIONAL" : "NONE";
}
export function serialFlags(mode: SerialMode): { trackSerials: boolean; serialsOptional: boolean } {
  return { trackSerials: mode === "REQUIRED", serialsOptional: mode === "OPTIONAL" };
}

const skuField = z.preprocess(
  (v) => {
    const n = normalizeCode(v);
    return n === "" || n === undefined ? null : n;
  },
  z.string().regex(SKU_RE, msg("catalog.errors.sku")).nullable(),
);
const barcodeField = z.preprocess((v) => {
  const n = normalizeCode(v);
  return n === "" || n === undefined ? null : n;
}, z.string().regex(BARCODE_RE, msg("catalog.errors.barcode")).nullable());
const colorField = z.preprocess(
  (v) => (typeof v === "string" ? (v.trim() === "" ? null : v.trim().toUpperCase()) : (v ?? null)),
  z.string().regex(/^#[0-9A-F]{6}$/, msg("variants.errors.color")).nullable(),
);

export const productSchema = z
  .object({
    /** Blank on a new product: generated (PREFIX-00001). Blank on an edit: unchanged. */
    sku: skuField,
    barcode: barcodeField,
    /** Ask for an internal EAN-13 barcode when there is none. */
    generateBarcode: boolField(false),
    nameEn: requiredText("catalog.nameEn", 200),
    nameAr: requiredText("catalog.nameAr", 200),
    categoryId: optionalId,
    brandId: optionalId,
    model: optionalText(100),
    description: optionalText(2000),
    unitId: requiredId("catalog.products.unit"),
    purchaseCost: moneyField(2),
    sellingPrice: moneyField(2),
    minStock: z.preprocess((v) => (v === "" || v === null || v === undefined ? 0 : v), countField),
    warrantyMonths: z.preprocess(
      (v) => toNumber(v) ?? 0,
      z.number({ error: msg("validation.number") }).int(msg("validation.wholeMonths")).min(0, msg("validation.negative")).max(600, msg("catalog.errors.warranty")),
    ),
    /** Older clients send trackSerials only; serialMode wins when both are given. */
    trackSerials: boolField(false),
    serialMode: z.preprocess((v) => (v === "" || v === null ? undefined : v), z.enum(SERIAL_MODES, { error: msg("variants.errors.serialMode") }).optional()),
    isActive: boolField(true),
    version: versionField,
  })
  .transform(({ serialMode, trackSerials, ...rest }) => {
    const mode: SerialMode = serialMode ?? (trackSerials ? "REQUIRED" : "NONE");
    return { ...rest, serialMode: mode, trackSerials: mode === "REQUIRED" };
  });
export type ProductInput = z.output<typeof productSchema>;

/** One variant of a product (colour / configuration). Shared details come from the product. */
export const variantSchema = z.object({
  sku: skuField,
  barcode: barcodeField,
  generateBarcode: boolField(false),
  variantNameEn: requiredText("variants.nameEn", 100),
  variantNameAr: requiredText("variants.nameAr", 100),
  colorHex: colorField,
  purchaseCost: moneyField(2),
  sellingPrice: moneyField(2),
  minStock: z.preprocess((v) => (v === "" || v === null || v === undefined ? 0 : v), countField),
  isActive: boolField(true),
  version: versionField,
});
export type VariantInput = z.output<typeof variantSchema>;

/** Several variants at once ("Black, Silver, Gold"). */
export const variantsBulkSchema = z.object({
  variants: z.array(variantSchema).min(1, msg("variants.errors.none")).max(50, msg("variants.errors.tooMany")),
});

/** An existing product becomes a variant of this one (it keeps its SKU, stock and history). */
export const attachVariantSchema = z.object({
  productId: requiredId("variants.existing"),
  variantNameEn: requiredText("variants.nameEn", 100),
  variantNameAr: requiredText("variants.nameAr", 100),
  colorHex: colorField,
});

// ---- Warehouses ------------------------------------------------------------------------------

export const warehouseSchema = z
  .object({
    code: z.preprocess(normalizeCode, z.string({ error: required("warehouses.code") }).min(1, required("warehouses.code")).regex(LOCATION_CODE_RE, msg("warehouses.errors.code"))),
    nameEn: requiredText("catalog.nameEn", 100),
    nameAr: requiredText("catalog.nameAr", 100),
    kind: z.enum(WAREHOUSE_KINDS as [WarehouseKind, ...WarehouseKind[]], { error: msg("warehouses.errors.kind") }),
    technicianId: optionalId,
    address: optionalText(300),
    allowNegative: boolField(false),
    isActive: boolField(true),
    version: versionField,
  })
  .superRefine((v, ctx) => {
    if (v.kind === "VEHICLE" && !v.technicianId) ctx.addIssue({ code: "custom", path: ["technicianId"], message: msg("warehouses.errors.technicianRequired") });
    if (v.kind !== "VEHICLE" && v.technicianId) ctx.addIssue({ code: "custom", path: ["technicianId"], message: msg("warehouses.errors.technicianOnlyVehicle") });
  });

export const binSchema = z.object({
  code: z.preprocess(normalizeCode, z.string({ error: required("warehouses.bins.code") }).min(1, required("warehouses.bins.code")).regex(LOCATION_CODE_RE, msg("warehouses.errors.code"))),
  name: optionalText(100),
  isActive: boolField(true),
});

// ---- Stock documents -------------------------------------------------------------------------

export const docLineSchema = z.object({
  productId: requiredId("stock.fields.product"),
  quantity: quantityField,
  unitCost: moneyField(4),
  fromBinId: optionalId,
  toBinId: optionalId,
  direction: z.preprocess((v) => (v === "" || v === undefined ? null : v), z.enum(ADJUST_DIRECTIONS as [AdjustDirection, ...AdjustDirection[]]).nullable()),
  serials: serialList,
  reason: optionalText(300),
});
export type DocLineInput = z.output<typeof docLineSchema>;

export const stockDocSchema = z
  .object({
    type: z.enum(STOCK_DOC_TYPES as [StockDocType, ...StockDocType[]], { error: msg("stock.errors.type") }),
    returnKind: z.preprocess((v) => (v === "" || v === undefined ? null : v), z.enum(RETURN_KINDS as [StockReturnKind, ...StockReturnKind[]]).nullable()),
    fromWarehouseId: optionalId,
    toWarehouseId: optionalId,
    documentDate: z.string({ error: msg("validation.dateRequired") }).refine(isValidDateString, msg("validation.date")),
    reference: optionalText(100),
    counterparty: optionalText(200),
    note: optionalText(1000),
    /** From the supplier master (receipts, supplier returns). */
    supplierId: optionalId,
    /** From the customers (customer returns). */
    customerId: optionalId,
    /** The booked visit, by its code (APT-000123 or 123): issues and returns. */
    appointmentRef: optionalText(20),
    clientRequestId: z.preprocess((v) => (v === "" ? undefined : v), z.string().min(8).max(64).optional()),
    version: versionField,
    lines: z.array(docLineSchema).min(1, msg("stock.errors.noLines")).max(200, msg("stock.errors.tooManyLines")),
  })
  .superRefine((v, ctx) => {
    if (v.type === "RETURN" && !v.returnKind) ctx.addIssue({ code: "custom", path: ["returnKind"], message: msg("stock.errors.returnKind") });
    const sides = docWarehouseSides(v.type, v.returnKind);
    if (sides.from && !v.fromWarehouseId) ctx.addIssue({ code: "custom", path: ["fromWarehouseId"], message: msg("stock.errors.fromWarehouse") });
    if (sides.to && !v.toWarehouseId) ctx.addIssue({ code: "custom", path: ["toWarehouseId"], message: msg("stock.errors.toWarehouse") });
    v.lines.forEach((line, i) => {
      if (v.type === "ADJUSTMENT") {
        if (!line.direction) ctx.addIssue({ code: "custom", path: ["lines", i, "direction"], message: msg("stock.errors.direction") });
        if (!line.reason) ctx.addIssue({ code: "custom", path: ["lines", i, "reason"], message: msg("stock.errors.adjustReason") });
      }
      if (v.type === "TRANSFER" && v.fromWarehouseId && v.fromWarehouseId === v.toWarehouseId && (line.fromBinId ?? "") === (line.toBinId ?? "")) {
        ctx.addIssue({ code: "custom", path: ["lines", i, "toBinId"], message: msg("stock.errors.sameLocation") });
      }
    });
  });
export type StockDocInput = z.output<typeof stockDocSchema>;

export const cancelDocSchema = z.object({ reason: optionalText(500), version: versionField });

// ---- Stocktakes ------------------------------------------------------------------------------

export const stocktakeCreateSchema = z.object({
  warehouseId: requiredId("stock.fields.warehouse"),
  note: optionalText(500),
});

export const stocktakeCountSchema = z.object({
  lines: z
    .array(
      z.object({
        lineId: z.string().min(1).max(64),
        countedQuantity: z.preprocess((v) => (v === "" || v === undefined ? null : v), countField.nullable()),
        countedSerials: serialList,
        reason: optionalText(300),
      }),
    )
    .min(1)
    .max(2000),
});

export const stocktakeAddLineSchema = z.object({ productId: requiredId("stock.fields.product"), binId: optionalId });

export const stocktakeDecisionSchema = z.object({ note: optionalText(500) });
