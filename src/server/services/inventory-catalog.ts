import "server-only";
import { Prisma } from "@prisma/client";
import { msg } from "@/i18n/translator";
import { brandSchema, categorySchema, productSchema, unitSchema } from "@/lib/inventory";
import { prisma } from "../db";
import { assertCan, hasPermission } from "../access";
import type { CurrentUser } from "../auth/session";
import { NotFoundError, StaleRecordError, ValidationError } from "../errors";
import { diffValues, recordAudit } from "./audit";
import { isUniqueViolation } from "./scheduling";
import { canSeeCosts, checkId, num, numOrNull, pageOf, parseInput as parse, warehouseScope } from "./inventory-common";

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

export type CategoryDTO = { id: string; nameEn: string; nameAr: string; parentId: string | null; isActive: boolean; sortOrder: number; productCount: number };

const categoryDTO = (c: Omit<CategoryDTO, "productCount">, productCount: number): CategoryDTO => ({
  id: c.id,
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
    const c = before ? await tx.catalogCategory.update({ where: { id: before.id }, data }) : await tx.catalogCategory.create({ data });
    await recordAudit(tx, {
      entityType: "PRODUCT",
      entityId: c.id,
      action: before ? "CATEGORY_UPDATED" : "CATEGORY_CREATED",
      summary: msg(before ? "audit.categoryUpdated" : "audit.categoryCreated", { name: user.name, category: c.nameEn, categoryAr: c.nameAr }),
      changes: before ? diffValues(before, c, ["nameEn", "nameAr", "parentId", "isActive", "sortOrder"]) : { nameEn: c.nameEn, nameAr: c.nameAr, parentId: c.parentId },
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
  trackSerials: boolean;
  isActive: boolean;
  version: number;
  onHand: number;
  low: boolean;
  createdAt: string;
};

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
    averageCost: costs ? num(p.averageCost) : null,
    sellingPrice: numOrNull(p.sellingPrice),
    minStock,
    warrantyMonths: p.warrantyMonths,
    trackSerials: p.trackSerials,
    isActive: p.isActive,
    version: p.version,
    onHand,
    low: minStock > 0 && onHand < minStock,
    createdAt: p.createdAt.toISOString(),
  };
}

/** On-hand totals of these products over the warehouses the reader may see (one query). */
async function onHandOf(user: CurrentUser, productIds: string[], warehouseId?: string | null): Promise<Map<string, number>> {
  if (!productIds.length) return new Map();
  const rows = await prisma.stockBalance.groupBy({
    by: ["productId"],
    where: { productId: { in: productIds }, warehouse: warehouseScope(user), ...(warehouseId ? { warehouseId } : {}) },
    _sum: { quantity: true },
  });
  return new Map(rows.map((r) => [r.productId, num(r._sum.quantity)]));
}

export const PRODUCT_SORTS = ["name", "sku", "created"] as const;
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
};

function productWhere(f: ProductFilters): Prisma.ProductWhereInput {
  const and: Prisma.ProductWhereInput[] = [];
  const q = f.q?.trim().slice(0, 100);
  if (q) {
    const code = q.replace(/\s+/g, "").toUpperCase();
    and.push({
      OR: [
        { sku: { contains: code } },
        { barcode: code },
        { nameEn: { contains: q, mode: "insensitive" } },
        { nameAr: { contains: q, mode: "insensitive" } },
        { model: { contains: q, mode: "insensitive" } },
      ],
    });
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
  const where = productWhere(f);
  const dir: Prisma.SortOrder = f.dir === "desc" ? "desc" : "asc";
  const orderBy: Prisma.ProductOrderByWithRelationInput[] =
    f.sort === "sku" ? [{ sku: dir }] : f.sort === "created" ? [{ createdAt: dir }, { sku: "asc" }] : [{ [user.locale === "ar" ? "nameAr" : "nameEn"]: dir }, { sku: "asc" }];
  const [total, rows] = await Promise.all([prisma.product.count({ where }), prisma.product.findMany({ where, include: productInclude, orderBy, skip, take })]);
  const onHand = await onHandOf(user, rows.map((r) => r.id), f.warehouseId ? checkId(f.warehouseId) : null);
  return { total, page, pageSize, pageCount: Math.max(1, Math.ceil(total / pageSize)), rows: rows.map((r) => toProductDTO(user, r, onHand.get(r.id) ?? 0)) };
}

export type ProductDetail = ProductDTO & {
  balances: { warehouseId: string; code: string; nameEn: string; nameAr: string; kind: string; bin: string | null; quantity: number }[];
  hasMovements: boolean;
  serialsInStock: number;
};

export async function getProduct(user: CurrentUser, id: string): Promise<ProductDetail> {
  assertCan(user, "products.view");
  const p = await prisma.product.findUnique({ where: { id: checkId(id) }, include: productInclude });
  if (!p) throw new NotFoundError();
  const [balances, moved, serials] = await Promise.all([
    hasPermission(user, "inventory.view")
      ? prisma.stockBalance.findMany({
          where: { productId: p.id, quantity: { not: 0 }, warehouse: warehouseScope(user) },
          include: { warehouse: { select: { id: true, code: true, nameEn: true, nameAr: true, kind: true } }, bin: { select: { code: true } } },
          orderBy: [{ warehouse: { code: "asc" } }, { binKey: "asc" }],
        })
      : Promise.resolve([]),
    prisma.inventoryMovement.findFirst({ where: { productId: p.id }, select: { id: true } }),
    p.trackSerials ? prisma.productSerial.count({ where: { productId: p.id, warehouseId: { not: null } } }) : Promise.resolve(0),
  ]);
  const onHand = balances.reduce((s, b) => s + num(b.quantity), 0);
  return {
    ...toProductDTO(user, p, onHand),
    balances: balances.map((b) => ({ warehouseId: b.warehouse.id, code: b.warehouse.code, nameEn: b.warehouse.nameEn, nameAr: b.warehouse.nameAr, kind: b.warehouse.kind, bin: b.bin?.code ?? null, quantity: num(b.quantity) })),
    hasMovements: !!moved,
    serialsInStock: serials,
  };
}

const AUDITED = ["sku", "barcode", "nameEn", "nameAr", "categoryId", "brandId", "model", "description", "unitId", "purchaseCost", "sellingPrice", "minStock", "warrantyMonths", "trackSerials", "isActive"];

export async function saveProduct(user: CurrentUser, id: string | null, raw: unknown): Promise<ProductDTO> {
  assertCan(user, "products.manage");
  const { version, ...data } = parse(productSchema, raw);
  try {
    return await prisma.$transaction(async (tx) => {
      const before = id ? await tx.product.findUnique({ where: { id: checkId(id) } }) : null;
      if (id && !before) throw new NotFoundError();
      if (before && version !== undefined && version !== before.version) throw new StaleRecordError();

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
      if (unit && data.trackSerials && unit.allowsFraction) errors.trackSerials = msg("catalog.errors.serialsWhole");
      if (unit && !unit.allowsFraction && !Number.isInteger(data.minStock)) errors.minStock = msg("stock.errors.wholeUnits", { unit: unit.nameEn, unitAr: unit.nameAr });
      // A product is retired only once its stock is gone; otherwise the stock could no longer be
      // issued, moved or counted (documents refuse inactive products).
      if (before?.isActive && !data.isActive) {
        const stocked = await tx.stockBalance.findFirst({ where: { productId: before.id, quantity: { not: 0 } }, select: { id: true } });
        if (stocked) errors.isActive = msg("catalog.errors.deactivateWithStock");
      }
      if (before && (before.unitId !== data.unitId || before.trackSerials !== data.trackSerials)) {
        const moved = await tx.inventoryMovement.findFirst({ where: { productId: before.id }, select: { id: true } });
        if (moved) {
          if (before.unitId !== data.unitId) errors.unitId = msg("catalog.errors.unitLocked");
          if (before.trackSerials !== data.trackSerials) errors.trackSerials = msg("catalog.errors.serialsLocked");
        }
      }
      const dupSku = await tx.product.findFirst({ where: { sku: data.sku, id: before ? { not: before.id } : undefined }, select: { id: true } });
      if (dupSku) errors.sku = msg("catalog.errors.skuTaken");
      if (data.barcode) {
        const dupBarcode = await tx.product.findFirst({ where: { barcode: data.barcode, id: before ? { not: before.id } : undefined }, select: { id: true } });
        if (dupBarcode) errors.barcode = msg("catalog.errors.barcodeTaken");
      }
      if (Object.keys(errors).length) throw new ValidationError(errors);

      const p = before
        ? await tx.product.update({ where: { id: before.id }, data: { ...data, updatedById: user.id, version: { increment: 1 } }, include: productInclude })
        : await tx.product.create({ data: { ...data, createdById: user.id }, include: productInclude });
      await recordAudit(tx, {
        entityType: "PRODUCT",
        entityId: p.id,
        action: before ? "PRODUCT_UPDATED" : "PRODUCT_CREATED",
        summary: msg(before ? "audit.productUpdated" : "audit.productCreated", { name: user.name, sku: p.sku, product: p.nameEn, productAr: p.nameAr }),
        changes: before ? diffValues(before, p, AUDITED) : Object.fromEntries(AUDITED.map((k) => [k, (p as Record<string, unknown>)[k] instanceof Prisma.Decimal ? num((p as Record<string, unknown>)[k] as Prisma.Decimal) : (p as Record<string, unknown>)[k]])),
        actorId: user.id,
      });
      const onHand = (await tx.stockBalance.aggregate({ where: { productId: p.id }, _sum: { quantity: true } }))._sum.quantity;
      return toProductDTO(user, p, num(onHand));
    });
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
    prisma.catalogCategory.findMany({ orderBy: [{ sortOrder: "asc" }, { nameEn: "asc" }], select: { id: true, nameEn: true, nameAr: true, parentId: true, isActive: true } }),
    prisma.brand.findMany({ orderBy: { name: "asc" }, select: { id: true, name: true, isActive: true } }),
  ]);
  return { units, categories, brands };
}
