/**
 * The product spreadsheet (import template, import and export use the same columns), shared by the
 * server and the browser. Pure: no database, no Excel library.
 *
 * Headers are matched loosely: the key ("sku"), the English or the Arabic label, or the template's
 * "English / عربي" header, ignoring case, spaces, "*" and punctuation. Unknown columns are ignored.
 */
import { foldText } from "./text";

export type ImportColumn = { key: string; en: string; ar: string; required?: "product" | "variant" | "always"; hintEn: string; hintAr: string };

export const PRODUCT_COLUMNS: ImportColumn[] = [
  { key: "sku", en: "SKU", ar: "الكود", hintEn: "Leave empty to generate (PREFIX-00001). An existing SKU updates that product when updates are allowed.", hintAr: "اتركه فارغًا ليُولَّد تلقائيًا. الكود الموجود يحدّث الصنف إذا سُمح بالتحديث." },
  { key: "parent_sku", en: "Parent SKU", ar: "كود الصنف الأب", hintEn: "Only for a variant: the SKU of its product (in the system or earlier in this file).", hintAr: "للنوع فقط: كود الصنف الذي يتبعه (في النظام أو في هذا الملف)." },
  { key: "name_en", en: "Name (English)", ar: "الاسم (إنجليزي)", required: "product", hintEn: "Required for a product.", hintAr: "مطلوب للصنف." },
  { key: "name_ar", en: "Name (Arabic)", ar: "الاسم (عربي)", required: "product", hintEn: "Required for a product.", hintAr: "مطلوب للصنف." },
  { key: "variant_en", en: "Variant (English)", ar: "النوع (إنجليزي)", required: "variant", hintEn: "Required for a variant, e.g. Black.", hintAr: "مطلوب للنوع، مثل Black." },
  { key: "variant_ar", en: "Variant (Arabic)", ar: "النوع (عربي)", required: "variant", hintEn: "Required for a variant, e.g. أسود.", hintAr: "مطلوب للنوع، مثل أسود." },
  { key: "color", en: "Colour", ar: "اللون", hintEn: "Optional, #RRGGBB.", hintAr: "اختياري، #RRGGBB." },
  { key: "category", en: "Category", ar: "الفئة", hintEn: "Category code, name, or \"Category > Subcategory\".", hintAr: "كود الفئة أو اسمها أو \"الفئة > الفرعية\"." },
  { key: "brand", en: "Brand", ar: "الماركة", hintEn: "Brand name.", hintAr: "اسم الماركة." },
  { key: "model", en: "Model", ar: "الموديل", hintEn: "Optional.", hintAr: "اختياري." },
  { key: "unit", en: "Unit", ar: "الوحدة", required: "product", hintEn: "Unit code (PCS, M, BOX...) or name.", hintAr: "كود الوحدة (PCS، M، BOX...) أو اسمها." },
  { key: "purchase_cost", en: "Purchase cost", ar: "سعر الشراء", hintEn: "Number, 2 decimals at most.", hintAr: "رقم، بحد أقصى رقمين عشريين." },
  { key: "selling_price", en: "Selling price", ar: "سعر البيع", hintEn: "Number, 2 decimals at most.", hintAr: "رقم، بحد أقصى رقمين عشريين." },
  { key: "min_stock", en: "Minimum stock", ar: "الحد الأدنى", hintEn: "Number (low-stock alert).", hintAr: "رقم (تنبيه نقص المخزون)." },
  { key: "warranty_months", en: "Warranty (months)", ar: "الضمان (شهور)", hintEn: "Whole months.", hintAr: "عدد شهور صحيح." },
  { key: "serial_mode", en: "Serial numbers", ar: "السيريال", hintEn: "NONE, OPTIONAL or REQUIRED (also: no / optional / yes).", hintAr: "NONE أو OPTIONAL أو REQUIRED (أو: لا / اختياري / نعم)." },
  { key: "barcode", en: "Barcode", ar: "الباركود", hintEn: "Optional; unique.", hintAr: "اختياري؛ فريد." },
  { key: "generate_barcode", en: "Generate barcode", ar: "توليد باركود", hintEn: "yes to issue an internal EAN-13 when the barcode is empty.", hintAr: "نعم لإصدار باركود داخلي EAN-13 إذا كان الباركود فارغًا." },
  { key: "description", en: "Description", ar: "الوصف", hintEn: "Optional.", hintAr: "اختياري." },
  { key: "active", en: "Active", ar: "نشط", hintEn: "yes (default) or no.", hintAr: "نعم (افتراضي) أو لا." },
];

/** Optional second sheet: opening stock, imported as DRAFT opening-balance documents to review and post. */
export const STOCK_COLUMNS: ImportColumn[] = [
  { key: "sku", en: "SKU", ar: "الكود", required: "always", hintEn: "A product or variant (in the system or in the products sheet).", hintAr: "صنف أو نوع (في النظام أو في ورقة الأصناف)." },
  { key: "warehouse", en: "Warehouse", ar: "المخزن", required: "always", hintEn: "Warehouse code, e.g. MAIN.", hintAr: "كود المخزن، مثل MAIN." },
  { key: "bin", en: "Bin", ar: "الرف", hintEn: "Optional bin code, e.g. A-01.", hintAr: "كود الرف (اختياري)، مثل A-01." },
  { key: "quantity", en: "Quantity", ar: "الكمية", required: "always", hintEn: "More than zero.", hintAr: "أكبر من صفر." },
  { key: "unit_cost", en: "Unit cost", ar: "تكلفة الوحدة", hintEn: "Empty = the product's purchase cost.", hintAr: "فارغ = سعر شراء الصنف." },
  { key: "serials", en: "Serial numbers", ar: "السيريالات", hintEn: "Separated by commas or spaces (one per unit for mandatory serials).", hintAr: "مفصولة بفواصل أو مسافات (سيريال لكل قطعة إذا كان إلزاميًا)." },
];

export const PRODUCTS_SHEET = { en: "Products", ar: "الأصناف" };
export const STOCK_SHEET = { en: "Opening stock", ar: "رصيد افتتاحي" };
export const MAX_IMPORT_ROWS = 10_000;
export const MAX_STOCK_ROWS = 20_000;
export const MAX_IMPORT_BYTES = 10 * 1024 * 1024;

export const headerOf = (c: ImportColumn) => `${c.en} / ${c.ar}`;

const normHeader = (s: string) => foldText(s).replace(/[*:()\s_\-./]+/g, "");

/** Which column key a header cell means, or null. */
export function columnKeyOf(header: string, columns: ImportColumn[] = PRODUCT_COLUMNS): string | null {
  const h = normHeader(header);
  if (!h) return null;
  for (const c of columns) {
    const names = [c.key, c.en, c.ar, headerOf(c), `${c.en}/${c.ar}`];
    if (names.some((n) => normHeader(n) === h)) return c.key;
  }
  // "English / عربي" with any spacing: either half is enough.
  for (const c of columns) if (header.split("/").some((part) => normHeader(part) === normHeader(c.en) || normHeader(part) === normHeader(c.ar))) return c.key;
  return null;
}

const YES = new Set(["yes", "y", "true", "1", "نعم", "ايوه", "اه", "x", "✓"]);
const NO = new Set(["no", "n", "false", "0", "لا", "لأ"]);

/** yes / no in English or Arabic; null for empty; undefined for anything else. */
export function parseYesNo(v: string): boolean | null | undefined {
  const s = foldText(v);
  if (!s) return null;
  if (YES.has(s)) return true;
  if (NO.has(s)) return false;
  return undefined;
}

/** NONE / OPTIONAL / REQUIRED from the cell (English, Arabic or yes/no); undefined when unknown. */
export function parseSerialMode(v: string): "NONE" | "OPTIONAL" | "REQUIRED" | null | undefined {
  const s = foldText(v);
  if (!s) return null;
  if (["none", "no", "n", "0", "false", "بدون", "لا", "notracked", "not tracked"].includes(s)) return "NONE";
  if (["optional", "opt", "اختياري", "اختيارى"].includes(s)) return "OPTIONAL";
  if (["required", "mandatory", "yes", "y", "1", "true", "الزامي", "إلزامي", "نعم", "مطلوب"].includes(s)) return "REQUIRED";
  return undefined;
}

/** Serial numbers in one cell: commas, semicolons, spaces or new lines. */
export function splitSerials(v: string): string[] {
  return v
    .split(/[\s,;،]+/)
    .map((x) => x.trim().toUpperCase())
    .filter(Boolean);
}
