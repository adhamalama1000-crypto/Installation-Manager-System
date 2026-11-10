import "server-only";
import { msg } from "@/i18n/translator";
import { attachVariantSchema, serialModeOf, variantsBulkSchema, variantSchema, type VariantInput } from "@/lib/inventory";
import { prisma, type Tx } from "../db";
import { assertCan } from "../access";
import type { CurrentUser } from "../auth/session";
import { NotFoundError, StaleRecordError, ValidationError } from "../errors";
import { diffValues, recordAudit } from "./audit";
import { isUniqueViolation } from "./scheduling";
import { getProduct, productDTOInTx, sharedOf, variantFullName, type ProductDetail, type ProductDTO } from "./inventory-catalog";
import { checkId, formError, parseInput as parse, productParam } from "./inventory-common";
import { TX_OPTIONS } from "./inventory-posting";
import { nextInternalBarcode, nextVariantCode } from "./product-codes";

/**
 * Product variants (colours, configurations). A variant is a stock-keeping product of its own
 * (own code, barcode, prices, minimum, images, stock per warehouse and bin, serials), linked to
 * its product with `parentId`. Category, brand, unit, model, description, warranty and serial mode
 * are the product's and are copied onto each variant, so the ledger, the posting engine and
 * stocktakes work on variants exactly as on any product. The product itself then holds no stock
 * (the database refuses ledger movements for it).
 */

/** Locks the product row so variant changes of one product run one after the other. */
async function lockParent(tx: Tx, parentId: string) {
  const found = await tx.$queryRaw<{ id: string }[]>`SELECT "id" FROM "products" WHERE "id" = ${parentId} FOR UPDATE`;
  if (!found.length) throw new NotFoundError();
  return tx.product.findUniqueOrThrow({ where: { id: parentId } });
}

const fold = (s: string) => s.trim().toLowerCase();

/** A product can get variants when it is not a variant, is active, and holds no stock itself. */
async function assertCanHaveVariants(tx: Tx, parent: Awaited<ReturnType<typeof lockParent>>) {
  if (parent.parentId) throw formError("variants.errors.isVariant");
  if (!parent.isActive) throw formError("variants.errors.parentInactive");
  if (!parent.hasVariants) {
    const stocked = await tx.stockBalance.findFirst({ where: { productId: parent.id, quantity: { not: 0 } }, select: { id: true } });
    if (stocked) throw formError("variants.errors.parentHasStock", productParam("product", parent));
  }
}

/** Creates one or more variants of a product; codes and (on request) barcodes are generated. */
export async function addVariants(user: CurrentUser, parentId: string, raw: unknown): Promise<{ created: ProductDTO[]; product: ProductDetail }> {
  assertCan(user, "products.manage");
  const { variants } = parse(variantsBulkSchema, raw);
  try {
    await prisma.$transaction(async (tx) => {
      const parent = await lockParent(tx, checkId(parentId));
      await assertCanHaveVariants(tx, parent);
      const existing = await tx.product.findMany({ where: { parentId: parent.id }, select: { variantNameEn: true, variantNameAr: true } });
      const namesEn = new Set(existing.map((v) => fold(v.variantNameEn ?? "")));
      const namesAr = new Set(existing.map((v) => (v.variantNameAr ?? "").trim()));
      const errors: Record<string, string> = {};
      const reserved = new Set<string>();
      const reservedBarcodes = new Set<string>();
      for (const [i, v] of variants.entries()) {
        if (namesEn.has(fold(v.variantNameEn)) || namesAr.has(v.variantNameAr.trim())) errors[`variants.${i}.variantNameEn`] = msg("variants.errors.nameTaken", { name: v.variantNameEn });
        namesEn.add(fold(v.variantNameEn));
        namesAr.add(v.variantNameAr.trim());
        if (v.sku) {
          if (reserved.has(v.sku) || (await tx.product.findUnique({ where: { sku: v.sku }, select: { id: true } }))) errors[`variants.${i}.sku`] = msg("catalog.errors.skuTaken");
          reserved.add(v.sku);
        }
        if (v.barcode) {
          if (reservedBarcodes.has(v.barcode) || (await tx.product.findUnique({ where: { barcode: v.barcode }, select: { id: true } }))) errors[`variants.${i}.barcode`] = msg("catalog.errors.barcodeTaken");
          reservedBarcodes.add(v.barcode);
        }
      }
      if (Object.keys(errors).length) throw new ValidationError({ _form: Object.values(errors)[0]!, ...errors }, Object.values(errors)[0]!);

      if (!parent.hasVariants) await tx.product.update({ where: { id: parent.id }, data: { hasVariants: true, updatedById: user.id, version: { increment: 1 } } });
      const shared = sharedOf(parent);
      for (const v of variants) {
        const sku = v.sku ?? (await nextVariantCode(tx, parent.sku, v.variantNameEn, reserved));
        const barcode = v.barcode ?? (v.generateBarcode ? await nextInternalBarcode(tx, reservedBarcodes) : null);
        const row = await tx.product.create({
          data: {
            ...shared,
            ...variantFullName(parent, v),
            sku,
            barcode,
            parentId: parent.id,
            variantNameEn: v.variantNameEn,
            variantNameAr: v.variantNameAr,
            colorHex: v.colorHex,
            // Prices default to the product's; each variant can have its own.
            purchaseCost: v.purchaseCost ?? parent.purchaseCost,
            sellingPrice: v.sellingPrice ?? parent.sellingPrice,
            minStock: v.minStock,
            isActive: v.isActive,
            createdById: user.id,
          },
        });
        await recordAudit(tx, {
          entityType: "PRODUCT",
          entityId: row.id,
          action: "VARIANT_CREATED",
          summary: msg("erpAudit.variantCreated", { name: user.name, sku: row.sku, product: parent.nameEn, productAr: parent.nameAr, variant: v.variantNameEn, variantAr: v.variantNameAr }),
          changes: { parentId: parent.id, sku: row.sku, barcode: row.barcode, variantNameEn: v.variantNameEn, variantNameAr: v.variantNameAr, colorHex: v.colorHex },
          actorId: user.id,
        });
      }
    }, TX_OPTIONS);
  } catch (e) {
    if (isUniqueViolation(e, "sku")) throw new ValidationError({ sku: msg("catalog.errors.skuTaken") });
    if (isUniqueViolation(e, "barcode")) throw new ValidationError({ barcode: msg("catalog.errors.barcodeTaken") });
    throw e;
  }
  const product = await getProduct(user, parentId);
  const names = new Set(variants.map((v) => fold(v.variantNameEn)));
  return { created: product.variants.filter((v) => names.has(fold(v.variantNameEn ?? ""))), product };
}

const VARIANT_AUDITED = ["sku", "barcode", "variantNameEn", "variantNameAr", "nameEn", "nameAr", "colorHex", "purchaseCost", "sellingPrice", "minStock", "isActive"];

/** Saves a variant's own fields inside the caller's transaction. */
export async function saveVariantInTx(tx: Tx, user: CurrentUser, parentId: string, variantId: string, v: VariantInput): Promise<ProductDTO> {
  const parent = await lockParent(tx, checkId(parentId));
  const before = await tx.product.findFirst({ where: { id: checkId(variantId), parentId: parent.id } });
  if (!before) throw new NotFoundError();
  if (v.version !== undefined && v.version !== before.version) throw new StaleRecordError();
  const errors: Record<string, string> = {};
  const sibling = await tx.product.findFirst({
    where: { parentId: parent.id, id: { not: before.id }, OR: [{ variantNameEn: { equals: v.variantNameEn.trim(), mode: "insensitive" } }, { variantNameAr: v.variantNameAr.trim() }] },
    select: { id: true },
  });
  if (sibling) errors.variantNameEn = msg("variants.errors.nameTaken", { name: v.variantNameEn });
  const sku = v.sku ?? before.sku;
  if (await tx.product.findFirst({ where: { sku, id: { not: before.id } }, select: { id: true } })) errors.sku = msg("catalog.errors.skuTaken");
  if (v.barcode && (await tx.product.findFirst({ where: { barcode: v.barcode, id: { not: before.id } }, select: { id: true } }))) errors.barcode = msg("catalog.errors.barcodeTaken");
  if (before.isActive && !v.isActive) {
    const stocked = await tx.stockBalance.findFirst({ where: { productId: before.id, quantity: { not: 0 } }, select: { id: true } });
    if (stocked) errors.isActive = msg("catalog.errors.deactivateWithStock");
  }
  if (v.isActive && !parent.isActive) errors.isActive = msg("variants.errors.parentInactive");
  const unit = await tx.unit.findUniqueOrThrow({ where: { id: parent.unitId } });
  if (!unit.allowsFraction && !Number.isInteger(v.minStock)) errors.minStock = msg("stock.errors.wholeUnits", { unit: unit.nameEn, unitAr: unit.nameAr });
  if (Object.keys(errors).length) throw new ValidationError(errors);

  const row = await tx.product.update({
    where: { id: before.id },
    data: {
      sku,
      barcode: v.barcode ?? before.barcode ?? (v.generateBarcode ? await nextInternalBarcode(tx) : null),
      variantNameEn: v.variantNameEn,
      variantNameAr: v.variantNameAr,
      ...variantFullName(parent, v),
      colorHex: v.colorHex,
      purchaseCost: v.purchaseCost,
      sellingPrice: v.sellingPrice,
      minStock: v.minStock,
      isActive: v.isActive,
      updatedById: user.id,
      version: { increment: 1 },
    },
  });
  await recordAudit(tx, {
    entityType: "PRODUCT",
    entityId: row.id,
    action: "VARIANT_UPDATED",
    summary: msg("erpAudit.variantUpdated", { name: user.name, sku: row.sku, product: parent.nameEn, productAr: parent.nameAr, variant: row.variantNameEn, variantAr: row.variantNameAr }),
    changes: diffValues(before, row, VARIANT_AUDITED),
    actorId: user.id,
  });
  return productDTOInTx(tx, user, row.id);
}

export async function saveVariant(user: CurrentUser, parentId: string, variantId: string, raw: unknown): Promise<ProductDTO> {
  assertCan(user, "products.manage");
  const v = parse(variantSchema, raw);
  try {
    const id = await prisma.$transaction(async (tx) => (await saveVariantInTx(tx, user, parentId, variantId, v)).id, TX_OPTIONS);
    return getProduct(user, id);
  } catch (e) {
    if (isUniqueViolation(e, "sku")) throw new ValidationError({ sku: msg("catalog.errors.skuTaken") });
    if (isUniqueViolation(e, "barcode")) throw new ValidationError({ barcode: msg("catalog.errors.barcodeTaken") });
    throw e;
  }
}

/**
 * An existing product becomes a variant of this one. It keeps its id, code, barcode, stock,
 * serials and history; its unit and serial mode must already match (the ledger depends on them),
 * and it takes the product's category, brand, model, description and warranty.
 */
export async function attachVariant(user: CurrentUser, parentId: string, raw: unknown): Promise<ProductDetail> {
  assertCan(user, "products.manage");
  const input = parse(attachVariantSchema, raw);
  await prisma.$transaction(async (tx) => {
    const parent = await lockParent(tx, checkId(parentId));
    await assertCanHaveVariants(tx, parent);
    if (input.productId === parent.id) throw formError("variants.errors.attachSelf", undefined, "productId");
    const child = await tx.product.findUnique({ where: { id: checkId(input.productId) } });
    if (!child) throw new NotFoundError();
    if (child.hasVariants) throw formError("variants.errors.attachHasVariants", productParam("product", child), "productId");
    if (child.parentId) throw formError("variants.errors.attachAlreadyVariant", productParam("product", child), "productId");
    if (child.unitId !== parent.unitId) throw formError("variants.errors.attachMismatch", { ...productParam("product", child), field: "@catalog.products.unit" }, "productId");
    if (serialModeOf(child) !== serialModeOf(parent)) throw formError("variants.errors.attachMismatch", { ...productParam("product", child), field: "@serialModes.label" }, "productId");
    const sibling = await tx.product.findFirst({
      where: { parentId: parent.id, OR: [{ variantNameEn: { equals: input.variantNameEn, mode: "insensitive" } }, { variantNameAr: input.variantNameAr }] },
      select: { id: true },
    });
    if (sibling) throw formError("variants.errors.nameTaken", { name: input.variantNameEn }, "variantNameEn");
    if (!parent.hasVariants) await tx.product.update({ where: { id: parent.id }, data: { hasVariants: true, updatedById: user.id, version: { increment: 1 } } });
    const row = await tx.product.update({
      where: { id: child.id },
      data: {
        parentId: parent.id,
        variantNameEn: input.variantNameEn,
        variantNameAr: input.variantNameAr,
        colorHex: input.colorHex,
        ...variantFullName(parent, input),
        categoryId: parent.categoryId,
        brandId: parent.brandId,
        model: parent.model,
        description: parent.description,
        warrantyMonths: parent.warrantyMonths,
        updatedById: user.id,
        version: { increment: 1 },
      },
    });
    await recordAudit(tx, {
      entityType: "PRODUCT",
      entityId: row.id,
      action: "VARIANT_ATTACHED",
      summary: msg("erpAudit.variantAttached", { name: user.name, sku: row.sku, product: parent.nameEn, productAr: parent.nameAr }),
      changes: diffValues(child, row, ["parentId", "variantNameEn", "variantNameAr", "colorHex", "nameEn", "nameAr", "categoryId", "brandId", "model", "description", "warrantyMonths"]),
      actorId: user.id,
    });
  }, TX_OPTIONS);
  return getProduct(user, parentId);
}

/** A variant becomes a separate product again (it keeps its code, stock and history). */
export async function detachVariant(user: CurrentUser, variantId: string): Promise<ProductDetail> {
  assertCan(user, "products.manage");
  const parentId = await prisma.$transaction(async (tx) => {
    const v = await tx.product.findUnique({ where: { id: checkId(variantId) } });
    if (!v?.parentId) throw new NotFoundError();
    const parent = await lockParent(tx, v.parentId);
    const row = await tx.product.update({ where: { id: v.id }, data: { parentId: null, variantNameEn: null, variantNameAr: null, updatedById: user.id, version: { increment: 1 } } });
    const left = await tx.product.count({ where: { parentId: parent.id } });
    if (!left) await tx.product.update({ where: { id: parent.id }, data: { hasVariants: false, updatedById: user.id, version: { increment: 1 } } });
    await recordAudit(tx, {
      entityType: "PRODUCT",
      entityId: row.id,
      action: "VARIANT_DETACHED",
      summary: msg("erpAudit.variantDetached", { name: user.name, sku: row.sku, product: parent.nameEn, productAr: parent.nameAr }),
      changes: { parentId: { from: parent.id, to: null }, variantNameEn: { from: v.variantNameEn, to: null }, variantNameAr: { from: v.variantNameAr, to: null } },
      actorId: user.id,
    });
    return parent.id;
  }, TX_OPTIONS);
  return getProduct(user, parentId);
}
