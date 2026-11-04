import "server-only";
import { Prisma } from "@prisma/client";
import { msg } from "@/i18n/translator";
import { brandSchema, categorySchema, productSchema, serialFlags, serialModeOf, unitSchema, type SerialMode } from "@/lib/inventory";
import { prisma, type Tx } from "../db";
import { assertCan, hasPermission } from "../access";
import type { CurrentUser } from "../auth/session";
import { NotFoundError, StaleRecordError, ValidationError } from "../errors";
import { diffValues, recordAudit } from "./audit";
import { isUniqueViolation } from "./scheduling";
import { canSeeCosts, checkId, num, numOrNull, pageOf, parseInput as parse, warehouseScope } from "./inventory-common";
import { TX_OPTIONS } from "./inventory-posting";
import { nextInternalBarcode, nextSku } from "./product-codes";

/**
 * Product catalogue: units of measure, categories (two levels), brands and products. Products are
 * deactivated, never deleted (trigger); a product's unit and serial tracking are fixed once stock
 * has moved.
 */

// ---- Units -----------------------------------------------------------------------------------

export type UnitDTO = { id: string; code: string; nameEn: string; nameAr: string; allowsFraction: boolean; isActive: boolean; sortOrder: number; productCount: number };

const unitDTO = (u: Omit<UnitDTO, "productCount">, productCount: number): UnitDTO => ({
  id: u.id,
  code: u.code,
  nameEn: u.nameEn,
  nameAr: u.nameAr,
  allowsFraction: u.allowsFraction,
  isActive: u.isActive,
  sortOrder: u.sortOrder,
  productCount,
});

export async function listUnits(user: CurrentUser): Promise<UnitDTO[]> {
  if (!hasPermission(user, "products.view") && !hasPermission(user, "inventory.view")) throw new NotFoundError();
  const rows = await prisma.unit.findMany({ orderBy: [{ sortOrder: "asc" }, { code: "asc" }], include: { _count: { select: { products: true } } } });
  return rows.map((u) => unitDTO(u, u._count.products));
}

export async function saveUnit(user: CurrentUser, id: string | null, raw: unknown): Promise<UnitDTO> {
  assertCan(user, "products.manage");
  const data = parse(unitSchema, raw);
  try {
    return await prisma.$transaction(async (tx) => {
      const before = id ? await tx.unit.findUnique({ where: { id: checkId(id) } }) : null;
      if (id && !before) throw new NotFoundError();
      if (before && before.allowsFraction !== data.allowsFraction) {
        const used = await tx.inventoryMovement.findFirst({ where: { product: { unitId: before.id } }, select: { id: true } });
        if (used) throw new ValidationError({ allowsFraction: msg("catalog.errors.unitInUse") }, msg("catalog.errors.unitInUse"));
      }
      const u = before ? await tx.unit.update({ where: { id: before.id }, data }) : await tx.unit.create({ data });
      await recordAudit(tx, {
        entityType: "PRODUCT",
        entityId: u.id,
        action: before ? "UNIT_UPDATED" : "UNIT_CREATED",
        summary: msg(before ? "audit.unitUpdated" : "audit.unitCreated", { name: user.name, code: u.code }),
        changes: before ? diffValues(before, u, ["code", "nameEn", "nameAr", "allowsFraction", "isActive", "sortOrder"]) : { code: u.code, nameEn: u.nameEn, nameAr: u.nameAr },
        actorId: user.id,
      });
      return unitDTO(u, await tx.product.count({ where: { unitId: u.id } }));
    });
  } catch (e) {
    if (isUniqueViolation(e, "code")) throw new ValidationError({ code: msg("catalog.errors.unitTaken") });
    throw e;
  }
}

// ---- Categories ------------------------------------------------------------------------------

export type CategoryDTO = { id: string; code: string | null; nameEn: string; nameAr: string; parentId: string | null; isActive: boolean; sortOrder: number; productCount: number };

const categoryDTO = (c: Omit<CategoryDTO, "productCount">, productCount: number): CategoryDTO => ({
  id: c.id,
  code: c.code,
  nameEn: c.nameEn,
  nameAr: c.nameAr,
  parentId: c.parentId,
  isActive: c.isActive,
  sortOrder: c.sortOrder,
  productCount,
});

export async function listCategories(user: CurrentUser): Promise<CategoryDTO[]> {
  if (!hasPermission(user, "products.view")) throw new NotFoundError();
  const rows = await prisma.catalogCategory.findMany({ orderBy: [{ sortOrder: "asc" }, { nameEn: "asc" }], include: { _count: { select: { products: true } } } });
  return rows.map((c) => categoryDTO(c, c._count.products));
}

export async function saveCategory(user: CurrentUser, id: string | null, raw: unknown): Promise<CategoryDTO> {
  assertCan(user, "products.manage");
  const data = parse(categorySchema, raw);
  return prisma.$transaction(async (tx) => {
    // Names are unique per level, compared case-insensitively; serialise saves so two people
    // cannot add the same name at the same moment.
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended('inventory:categories', 0))`;
    const before = id ? await tx.catalogCategory.findUnique({ where: { id: checkId(id) }, include: { _count: { select: { children: true } } } }) : null;
    if (id && !before) throw new NotFoundError();
    if (data.parentId) {
      if (data.parentId === before?.id) throw new ValidationError({ parentId: msg("catalog.errors.parentSelf") });
      const parent = await tx.catalogCategory.findUnique({ where: { id: data.parentId } });
      if (!parent) throw new ValidationError({ parentId: msg("catalog.errors.parent") });
      if (parent.parentId) throw new ValidationError({ parentId: msg("catalog.errors.twoLevels") });
      if (before && before._count.children > 0) throw new ValidationError({ parentId: msg("catalog.errors.hasChildren") });
    }
    const dup = await tx.catalogCategory.findFirst({
      where: { parentId: data.parentId, id: before ? { not: before.id } : undefined, OR: [{ nameEn: { equals: data.nameEn, mode: "insensitive" } }, { nameAr: data.nameAr }] },
      select: { id: true },
    });
    if (dup) throw new ValidationError({ nameEn: msg("catalog.errors.categoryTaken") });
    if (data.code) {
      const codeDup = await tx.catalogCategory.findFirst({ where: { code: data.code, id: before ? { not: before.id } : undefined }, select: { id: true } });
      if (codeDup) throw new ValidationError({ code: msg("variants.errors.categoryCodeTaken") });
    }
    const c = before ? await tx.catalogCategory.update({ where: { id: before.id }, data }) : await tx.catalogCategory.create({ data });
    await recordAudit(tx, {
      entityType: "PRODUCT",
      entityId: c.id,
      action: before ? "CATEGORY_UPDATED" : "CATEGORY_CREATED",
      summary: msg(before ? "audit.categoryUpdated" : "audit.categoryCreated", { name: user.name, category: c.nameEn, categoryAr: c.nameAr }),
      changes: before ? diffValues(before, c, ["code", "nameEn", "nameAr", "parentId", "isActive", "sortOrder"]) : { code: c.code, nameEn: c.nameEn, nameAr: c.nameAr, parentId: c.parentId },
      actorId: user.id,
    });
    return categoryDTO(c, await tx.product.count({ where: { categoryId: c.id } }));
  });
}

// ---- Brands ----------------------------------------------------------------------------------

export type BrandDTO = { id: string; name: string; isActive: boolean; productCount: number };

export async function listBrands(user: CurrentUser): Promise<BrandDTO[]> {
  if (!hasPermission(user, "products.view")) throw new NotFoundError();
  const rows = await prisma.brand.findMany({ orderBy: { name: "asc" }, include: { _count: { select: { products: true } } } });
  return rows.map((b) => ({ id: b.id, name: b.name, isActive: b.isActive, productCount: b._count.products }));
}

export async function saveBrand(user: CurrentUser, id: string | null, raw: unknown): Promise<BrandDTO> {
  assertCan(user, "products.manage");
  const data = parse(brandSchema, raw);
  try {
    return await prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended('inventory:brands', 0))`;
      const before = id ? await tx.brand.findUnique({ where: { id: checkId(id) } }) : null;
      if (id && !before) throw new NotFoundError();
      const dup = await tx.brand.findFirst({ where: { name: { equals: data.name, mode: "insensitive" }, id: before ? { not: before.id } : undefined }, select: { id: true } });
      if (dup) throw new ValidationError({ name: msg("catalog.errors.brandTaken") });
      const b = before ? await tx.brand.update({ where: { id: before.id }, data }) : await tx.brand.create({ data });
      await recordAudit(tx, {
        entityType: "PRODUCT",
        entityId: b.id,
        action: before ? "BRAND_UPDATED" : "BRAND_CREATED",
        summary: msg(before ? "audit.brandUpdated" : "audit.brandCreated", { name: user.name, brand: b.name }),
        changes: before ? diffValues(before, b, ["name", "isActive"]) : { name: b.name },
        actorId: user.id,
      });
      const count = await tx.product.count({ where: { brandId: b.id } });
      return { id: b.id, name: b.name, isActive: b.isActive, productCount: count };
    });
  } catch (e) {
    if (isUniqueViolation(e, "name")) throw new ValidationError({ name: msg("catalog.errors.brandTaken") });
    throw e;
  }
}

// ---- Products --------------------------------------------------------------------------------

const productInclude = {
  unit: { select: { id: true, code: true, nameEn: true, nameAr: true, allowsFraction: true } },
  category: { select: { id: true, nameEn: true, nameAr: true, parent: { select: { id: true, nameEn: true, nameAr: true } } } },
  brand: { select: { id: true, name: true } },
  parent: { select: { id: true, sku: true, nameEn: true, nameAr: true } },
  images: { where: { deletedAt: null }, orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }], select: { id: true }, take: 1 },
  _count: { select: { variants: true } },
} satisfies Prisma.ProductInclude;
type ProductRow = Prisma.ProductGetPayload<{ include: typeof productInclude }>;

export type ProductDTO = {
  id: string;
  sku: string;
  barcode: string | null;
  nameEn: string;
  nameAr: string;
  model: string | null;
  description: string | null;
  unit: { id: string; code: string; nameEn: string; nameAr: string; allowsFraction: boolean };
  category: { id: string; nameEn: string; nameAr: string } | null;
  /** The top category when the product is in a subcategory. */
  parentCategory: { id: string; nameEn: string; nameAr: string } | null;
  brand: { id: string; name: string } | null;
  /** Null when the reader may not see costs. */
  purchaseCost: number | null;
  averageCost: number | null;
  sellingPrice: number | null;
  minStock: number;
  warrantyMonths: number;
  /** Mandatory serials (kept for older clients; see serialMode). */
  trackSerials: boolean;
  serialMode: SerialMode;
  /** The product has variants: stock is on the variants. */
  hasVariants: boolean;
  variantCount: number;
  /** For a variant: the product it belongs to, and its own name and colour. */
  parent: { id: string; sku: string; nameEn: string; nameAr: string } | null;
  variantNameEn: string | null;
  variantNameAr: string | null;
  colorHex: string | null;
  /** The first image, if any. */
  imageUrl: string | null;
  isActive: boolean;
  version: number;
  /** For a product with variants: the total of its variants. */
  onHand: number;
  low: boolean;
  createdAt: string;
};

export const productImageUrl = (id: string) => `/api/product-images/${id}`;

/** One product as the API shows it, read inside a transaction (after a save). */
export async function productDTOInTx(tx: Tx, user: CurrentUser, id: string): Promise<ProductDTO> {
  const p = await tx.product.findUniqueOrThrow({ where: { id }, include: productInclude });
  const ids = p.hasVariants ? [p.id, ...(await tx.product.findMany({ where: { parentId: p.id }, select: { id: true } })).map((v) => v.id)] : [p.id];
  const onHand = (await tx.stockBalance.aggregate({ where: { productId: { in: ids } }, _sum: { quantity: true } }))._sum.quantity;
  return toProductDTO(user, p, num(onHand));
}

function toProductDTO(user: CurrentUser, p: ProductRow, onHand: number): ProductDTO {
  const costs = canSeeCosts(user);
  const minStock = num(p.minStock);
  return {
    id: p.id,
    sku: p.sku,
    barcode: p.barcode,
    nameEn: p.nameEn,
    nameAr: p.nameAr,
    model: p.model,
    description: p.description,
    unit: p.unit,
    category: p.category ? { id: p.category.id, nameEn: p.category.nameEn, nameAr: p.category.nameAr } : null,
    parentCategory: p.category?.parent ?? null,
    brand: p.brand,
    purchaseCost: costs ? numOrNull(p.purchaseCost) : null,
    averageCost: costs && !p.hasVariants ? num(p.averageCost) : null,
    sellingPrice: numOrNull(p.sellingPrice),
    minStock,
    warrantyMonths: p.warrantyMonths,
    trackSerials: p.trackSerials,
    serialMode: serialModeOf(p),
    hasVariants: p.hasVariants,
    variantCount: p._count.variants,
    parent: p.parent,
    variantNameEn: p.variantNameEn,
    variantNameAr: p.variantNameAr,
    colorHex: p.colorHex,
    imageUrl: p.images[0] ? productImageUrl(p.images[0].id) : null,
    isActive: p.isActive,
    version: p.version,
    onHand,
    low: minStock > 0 && onHand < minStock,
    createdAt: p.createdAt.toISOString(),
  };
}

/**
 * On-hand totals of these products over the warehouses the reader may see (two queries at most).
 * A product with variants gets the total of its variants.
 */
async function onHandOf(user: CurrentUser, rows: { id: string; hasVariants: boolean }[], warehouseId?: string | null): Promise<Map<string, number>> {
  if (!rows.length) return new Map();
  const parents = rows.filter((r) => r.hasVariants).map((r) => r.id);
  const variants = parents.length ? await prisma.product.findMany({ where: { parentId: { in: parents } }, select: { id: true, parentId: true } }) : [];
  const owner = new Map<string, string>(rows.map((r) => [r.id, r.id]));
  for (const v of variants) owner.set(v.id, v.parentId!);
  const totals = await prisma.stockBalance.groupBy({
    by: ["productId"],
    where: { productId: { in: [...owner.keys()] }, warehouse: warehouseScope(user), ...(warehouseId ? { warehouseId } : {}) },
    _sum: { quantity: true },
  });
  const out = new Map<string, number>();
  for (const t of totals) {
    const id = owner.get(t.productId)!;
    out.set(id, (out.get(id) ?? 0) + num(t._sum.quantity));
  }
  return out;
}

export const PRODUCT_SORTS = ["name", "sku", "created"] as const;
/** top = products and standalone products (the catalogue list); stock = what holds stock (pickers); all. */
export const PRODUCT_LEVELS = ["top", "stock", "all"] as const;
export type ProductFilters = {
  q?: string;
  categoryId?: string;
  brandId?: string;
  unitId?: string;
  active?: string;
  sort?: string;
  dir?: string;
  page?: number;
  pageSize?: number;
  /** Availability at this warehouse instead of the total (the document line picker). */
  warehouseId?: string;
  /** Default "stock": every product that can be on a document (variants, not their parents). */
  level?: string;
  /** Only the variants of this product. */
  parentId?: string;
};

function productWhere(f: ProductFilters): Prisma.ProductWhereInput {
  const and: Prisma.ProductWhereInput[] = [];
  const level = (PRODUCT_LEVELS as readonly string[]).includes(f.level ?? "") ? f.level : "stock";
  if (level === "top") and.push({ parentId: null });
  else if (level === "stock") and.push({ hasVariants: false });
  if (f.parentId) and.push({ parentId: f.parentId });
  const q = f.q?.trim().slice(0, 100);
  if (q) {
    const code = q.replace(/\s+/g, "").toUpperCase();
    const own: Prisma.ProductWhereInput[] = [
      { sku: { contains: code } },
      { barcode: code },
      { nameEn: { contains: q, mode: "insensitive" } },
      { nameAr: { contains: q, mode: "insensitive" } },
      { model: { contains: q, mode: "insensitive" } },
    ];
    // In the catalogue list a product is found by the codes and names of its variants too.
    if (level === "top") own.push({ variants: { some: { OR: [{ sku: { contains: code } }, { barcode: code }, { variantNameEn: { contains: q, mode: "insensitive" } }, { variantNameAr: { contains: q, mode: "insensitive" } }] } } });
    and.push({ OR: own });
  }
  if (f.categoryId) and.push({ OR: [{ categoryId: f.categoryId }, { category: { parentId: f.categoryId } }] });
  if (f.brandId) and.push({ brandId: f.brandId });
  if (f.unitId) and.push({ unitId: f.unitId });
  if (f.active !== "all") and.push({ isActive: f.active !== "0" });
  return and.length ? { AND: and } : {};
}

export async function listProducts(user: CurrentUser, f: ProductFilters) {
  // The picker on stock documents also needs product names for people who move stock.
  if (!hasPermission(user, "products.view") && !hasPermission(user, "inventory.view")) throw new NotFoundError();
  const pageSize = Math.min(100, Math.max(5, f.pageSize ?? 25));
  const { page, skip, take } = pageOf(f.page, pageSize);
  const where = productWhere({ ...f, parentId: f.parentId ? checkId(f.parentId) : undefined });
  const dir: Prisma.SortOrder = f.dir === "desc" ? "desc" : "asc";
  const orderBy: Prisma.ProductOrderByWithRelationInput[] =
    f.sort === "sku" ? [{ sku: dir }] : f.sort === "created" ? [{ createdAt: dir }, { sku: "asc" }] : [{ [user.locale === "ar" ? "nameAr" : "nameEn"]: dir }, { sku: "asc" }];
  const [total, rows] = await Promise.all([prisma.product.count({ where }), prisma.product.findMany({ where, include: productInclude, orderBy, skip, take })]);
  const onHand = await onHandOf(user, rows, f.warehouseId ? checkId(f.warehouseId) : null);
  return { total, page, pageSize, pageCount: Math.max(1, Math.ceil(total / pageSize)), rows: rows.map((r) => toProductDTO(user, r, onHand.get(r.id) ?? 0)) };
}

export type ProductDetail = ProductDTO & {
  balances: { warehouseId: string; code: string; nameEn: string; nameAr: string; kind: string; bin: string | null; quantity: number }[];
  /** This product, or for a product with variants any of its variants, has stock movements. */
  hasMovements: boolean;
  serialsInStock: number;
  variants: ProductDTO[];
  images: { id: string; url: string }[];
};

export async function getProduct(user: CurrentUser, id: string): Promise<ProductDetail> {
  assertCan(user, "products.view");
  const p = await prisma.product.findUnique({ where: { id: checkId(id) }, include: productInclude });
  if (!p) throw new NotFoundError();
  const variantRows = p.hasVariants
    ? await prisma.product.findMany({ where: { parentId: p.id }, include: productInclude, orderBy: [{ isActive: "desc" }, { sku: "asc" }] })
    : [];
  const ids = [p.id, ...variantRows.map((v) => v.id)];
  const [balances, moved, serials, images, variantOnHand] = await Promise.all([
    hasPermission(user, "inventory.view")
      ? prisma.stockBalance.findMany({
          where: { productId: { in: ids }, quantity: { not: 0 }, warehouse: warehouseScope(user) },
          include: { warehouse: { select: { id: true, code: true, nameEn: true, nameAr: true, kind: true } }, bin: { select: { code: true } } },
          orderBy: [{ warehouse: { code: "asc" } }, { binKey: "asc" }],
        })
      : Promise.resolve([]),
    prisma.inventoryMovement.findFirst({ where: { productId: { in: ids } }, select: { id: true } }),
    p.trackSerials || p.serialsOptional ? prisma.productSerial.count({ where: { productId: { in: ids }, warehouseId: { not: null } } }) : Promise.resolve(0),
    prisma.productImage.findMany({ where: { productId: p.id, deletedAt: null }, orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }], select: { id: true } }),
    onHandOf(user, variantRows),
  ]);
  // Per warehouse and bin: for a product with variants, the variants added together.
  const merged = new Map<string, ProductDetail["balances"][number]>();
  for (const b of balances) {
    const k = `${b.warehouse.id}|${b.binKey}`;
    const row = merged.get(k) ?? { warehouseId: b.warehouse.id, code: b.warehouse.code, nameEn: b.warehouse.nameEn, nameAr: b.warehouse.nameAr, kind: b.warehouse.kind, bin: b.bin?.code ?? null, quantity: 0 };
    row.quantity += num(b.quantity);
    merged.set(k, row);
  }
  const onHand = balances.reduce((s, b) => s + num(b.quantity), 0);
  return {
    ...toProductDTO(user, p, onHand),
    balances: [...merged.values()].filter((b) => b.quantity !== 0),
    hasMovements: !!moved,
    serialsInStock: serials,
    variants: variantRows.map((v) => toProductDTO(user, v, variantOnHand.get(v.id) ?? 0)),
    images: images.map((i) => ({ id: i.id, url: productImageUrl(i.id) })),
  };
}

const AUDITED = ["sku", "barcode", "nameEn", "nameAr", "categoryId", "brandId", "model", "description", "unitId", "purchaseCost", "sellingPrice", "minStock", "warrantyMonths", "trackSerials", "serialsOptional", "isActive"];
/** What a variant takes from its product. */
export const SHARED_WITH_VARIANTS = ["categoryId", "brandId", "model", "description", "unitId", "warrantyMonths", "trackSerials", "serialsOptional"] as const;

/** The details a variant takes from its product (typed, for create and update). */
export function sharedOf(p: { categoryId: string | null; brandId: string | null; model: string | null; description: string | null; unitId: string; warrantyMonths: number; trackSerials: boolean; serialsOptional: boolean }) {
  return { categoryId: p.categoryId, brandId: p.brandId, model: p.model, description: p.description, unitId: p.unitId, warrantyMonths: p.warrantyMonths, trackSerials: p.trackSerials, serialsOptional: p.serialsOptional };
}

export const variantFullName = (parent: { nameEn: string; nameAr: string }, v: { variantNameEn: string; variantNameAr: string }) => ({
  nameEn: `${parent.nameEn} - ${v.variantNameEn}`,
  nameAr: `${parent.nameAr} - ${v.variantNameAr}`,
});

const snapshot = (p: Record<string, unknown>) => Object.fromEntries(AUDITED.map((k) => [k, p[k] instanceof Prisma.Decimal ? num(p[k] as Prisma.Decimal) : p[k]]));

/**
 * Checks a change of unit or serial mode against the stock that has already moved (for a product
 * with variants: on any variant). Field errors are added to `errors`.
 */
async function checkLockedChanges(
  tx: Tx,
  before: { id: string; unitId: string; trackSerials: boolean; serialsOptional: boolean; hasVariants: boolean },
  next: { unitId: string; serialMode: SerialMode },
  errors: Record<string, string>,
) {
  const from = serialModeOf(before);
  if (before.unitId === next.unitId && from === next.serialMode) return;
  const ids = before.hasVariants ? [before.id, ...(await tx.product.findMany({ where: { parentId: before.id }, select: { id: true } })).map((v) => v.id)] : [before.id];
  const moved = await tx.inventoryMovement.findFirst({ where: { productId: { in: ids } }, select: { id: true } });
  if (moved && before.unitId !== next.unitId) errors.unitId = msg(before.hasVariants ? "variants.errors.sharedLocked" : "catalog.errors.unitLocked");
  if (from !== next.serialMode) {
    // Relaxing mandatory serials to optional keeps every recorded serial valid; anything else
    // would leave the ledger's serials inconsistent once stock has moved.
    const relax = from === "REQUIRED" && next.serialMode === "OPTIONAL";
    if (moved && !relax && !(from === "NONE" && next.serialMode === "OPTIONAL")) {
      errors.serialMode = msg(from === "OPTIONAL" && next.serialMode === "NONE" ? "serialModes.optionalNoSerialsInStock" : "serialModes.relaxOnly");
      errors.trackSerials = errors.serialMode;
    }
    if (from === "OPTIONAL" && next.serialMode === "NONE" && !errors.serialMode) {
      const kept = await tx.productSerial.findFirst({ where: { productId: { in: ids }, warehouseId: { not: null } }, select: { id: true } });
      if (kept) errors.serialMode = msg("serialModes.optionalNoSerialsInStock");
    }
  }
}

export async function saveProduct(user: CurrentUser, id: string | null, raw: unknown): Promise<ProductDTO> {
  assertCan(user, "products.manage");
  // trackSerials is derived from serialMode (kept in the parsed input for older clients).
  const { version, serialMode, generateBarcode, sku: skuIn, trackSerials: _trackSerials, ...data } = parse(productSchema, raw);
  void _trackSerials;
  try {
    return await prisma.$transaction(async (tx) => {
      const before = id ? await tx.product.findUnique({ where: { id: checkId(id) } }) : null;
      if (id && !before) throw new NotFoundError();
      if (before && version !== undefined && version !== before.version) throw new StaleRecordError();
      // A variant's shared details are set on its product: only its own fields change here.
      if (before?.parentId) {
        const { saveVariantInTx } = await import("./product-variants");
        return saveVariantInTx(tx, user, before.parentId, before.id, {
          sku: skuIn,
          barcode: data.barcode,
          generateBarcode,
          variantNameEn: before.variantNameEn!,
          variantNameAr: before.variantNameAr!,
          colorHex: before.colorHex,
          purchaseCost: data.purchaseCost,
          sellingPrice: data.sellingPrice,
          minStock: data.minStock,
          isActive: data.isActive,
          version,
        });
      }

      const errors: Record<string, string> = {};
      const [unit, category, brand] = await Promise.all([
        tx.unit.findUnique({ where: { id: data.unitId } }),
        data.categoryId ? tx.catalogCategory.findUnique({ where: { id: data.categoryId } }) : null,
        data.brandId ? tx.brand.findUnique({ where: { id: data.brandId } }) : null,
      ]);
      // An inactive choice may stay on a product that already has it, but not be newly picked.
      if (!unit || (!unit.isActive && unit.id !== before?.unitId)) errors.unitId = msg("catalog.errors.unit");
      if (data.categoryId && (!category || (!category.isActive && category.id !== before?.categoryId))) errors.categoryId = msg("catalog.errors.category");
      if (data.brandId && (!brand || (!brand.isActive && brand.id !== before?.brandId))) errors.brandId = msg("catalog.errors.brand");
      if (unit && serialMode !== "NONE" && unit.allowsFraction) errors.trackSerials = errors.serialMode = msg("catalog.errors.serialsWhole");
      if (unit && !unit.allowsFraction && !Number.isInteger(data.minStock)) errors.minStock = msg("stock.errors.wholeUnits", { unit: unit.nameEn, unitAr: unit.nameAr });
      // A product is retired only once its stock is gone; otherwise the stock could no longer be
      // issued, moved or counted (documents refuse inactive products). A product with variants:
      // once all of its variants are empty.
      if (before?.isActive && !data.isActive) {
        const ids = before.hasVariants ? (await tx.product.findMany({ where: { parentId: before.id }, select: { id: true } })).map((v) => v.id) : [before.id];
        const stocked = await tx.stockBalance.findFirst({ where: { productId: { in: ids }, quantity: { not: 0 } }, select: { id: true } });
        if (stocked) errors.isActive = msg(before.hasVariants ? "variants.errors.deactivateWithVariantStock" : "catalog.errors.deactivateWithStock");
      }
      if (before) await checkLockedChanges(tx, before, { unitId: data.unitId, serialMode }, errors);
      const sku = skuIn ?? before?.sku ?? null;
      if (sku) {
        const dupSku = await tx.product.findFirst({ where: { sku, id: before ? { not: before.id } : undefined }, select: { id: true } });
        if (dupSku) errors.sku = msg("catalog.errors.skuTaken");
      }
      if (data.barcode) {
        const dupBarcode = await tx.product.findFirst({ where: { barcode: data.barcode, id: before ? { not: before.id } : undefined }, select: { id: true } });
        if (dupBarcode) errors.barcode = msg("catalog.errors.barcodeTaken");
      }
      if (Object.keys(errors).length) throw new ValidationError(errors);

      const values = {
        ...data,
        ...serialFlags(serialMode),
        sku: sku ?? (await nextSku(tx, data.categoryId)),
        barcode: data.barcode ?? before?.barcode ?? (generateBarcode ? await nextInternalBarcode(tx) : null),
      };
      const p = before
        ? await tx.product.update({ where: { id: before.id }, data: { ...values, updatedById: user.id, version: { increment: 1 } }, include: productInclude })
        : await tx.product.create({ data: { ...values, createdById: user.id }, include: productInclude });

      // Variants follow their product's shared details and names.
      let variantsUpdated = 0;
      if (before?.hasVariants) {
        const shared = sharedOf(p);
        const vs = await tx.product.findMany({ where: { parentId: p.id }, select: { id: true, variantNameEn: true, variantNameAr: true, isActive: true } });
        for (const v of vs) {
          await tx.product.update({
            where: { id: v.id },
            data: { ...shared, ...variantFullName(p, { variantNameEn: v.variantNameEn!, variantNameAr: v.variantNameAr! }), ...(p.isActive ? {} : { isActive: false }), updatedById: user.id, version: { increment: 1 } },
          });
          variantsUpdated++;
        }
      }
      await recordAudit(tx, {
        entityType: "PRODUCT",
        entityId: p.id,
        action: before ? "PRODUCT_UPDATED" : "PRODUCT_CREATED",
        summary: msg(before ? "audit.productUpdated" : "audit.productCreated", { name: user.name, sku: p.sku, product: p.nameEn, productAr: p.nameAr }),
        changes: before ? { ...diffValues(before, p, AUDITED), ...(variantsUpdated ? { variantsUpdated } : {}) } : snapshot(p as unknown as Record<string, unknown>),
        actorId: user.id,
      });
      return productDTOInTx(tx, user, p.id);
    }, TX_OPTIONS);
  } catch (e) {
    if (isUniqueViolation(e, "sku")) throw new ValidationError({ sku: msg("catalog.errors.skuTaken") });
    if (isUniqueViolation(e, "barcode")) throw new ValidationError({ barcode: msg("catalog.errors.barcodeTaken") });
    throw e;
  }
}

/** Lookups for product and document forms (active choices only, plus everything for filters). */
export async function catalogOptions(user: CurrentUser) {
  if (!hasPermission(user, "products.view") && !hasPermission(user, "inventory.view")) throw new NotFoundError();
  const [units, categories, brands] = await Promise.all([
    prisma.unit.findMany({ orderBy: [{ sortOrder: "asc" }, { code: "asc" }], select: { id: true, code: true, nameEn: true, nameAr: true, allowsFraction: true, isActive: true } }),
    prisma.catalogCategory.findMany({ orderBy: [{ sortOrder: "asc" }, { nameEn: "asc" }], select: { id: true, code: true, nameEn: true, nameAr: true, parentId: true, isActive: true } }),
    prisma.brand.findMany({ orderBy: { name: "asc" }, select: { id: true, name: true, isActive: true } }),
  ]);
  return { units, categories, brands };
}
