import "server-only";
import { createHash } from "node:crypto";
import { msg } from "@/i18n/translator";
import { prisma } from "../db";
import { assertCan, hasPermission } from "../access";
import type { CurrentUser } from "../auth/session";
import { NotFoundError, ValidationError } from "../errors";
import { detectImageType, discardFile, readStoredFile, saveFile } from "../storage";
import { recordAudit } from "./audit";
import { productImageUrl } from "./inventory-catalog";
import { checkId } from "./inventory-common";

/**
 * Product and variant photos. Same rules as visit photos: the file type is read from the bytes
 * (JPEG, PNG or WebP; never SVG or a renamed file), the size is limited, the bytes go to file
 * storage outside the public folder and are served only through a permission-checked route, and
 * removing an image only marks its row.
 */

export const MAX_PRODUCT_IMAGES = 8;

export type ProductImageDTO = { id: string; url: string };

async function current(productId: string) {
  return prisma.productImage.findMany({ where: { productId, deletedAt: null }, orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }], select: { id: true, sortOrder: true } });
}

export async function listProductImages(user: CurrentUser, productId: string): Promise<ProductImageDTO[]> {
  if (!hasPermission(user, "products.view") && !hasPermission(user, "inventory.view")) throw new NotFoundError();
  return (await current(checkId(productId))).map((i) => ({ id: i.id, url: productImageUrl(i.id) }));
}

export async function uploadProductImage(user: CurrentUser, productId: string, bytes: Uint8Array | null): Promise<ProductImageDTO> {
  assertCan(user, "products.manage");
  if (!bytes) throw new ValidationError({ file: msg("attachments.errors.tooLarge") }, msg("attachments.errors.tooLarge"));
  const type = detectImageType(bytes);
  if (!type) throw new ValidationError({ file: msg("attachments.errors.type") }, msg("attachments.errors.type"));
  const product = await prisma.product.findUnique({ where: { id: checkId(productId) }, select: { id: true, sku: true } });
  if (!product) throw new NotFoundError();
  const key = await saveFile(bytes, type);
  try {
    return await prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT "id" FROM "products" WHERE "id" = ${product.id} FOR UPDATE`;
      const rows = await tx.productImage.findMany({ where: { productId: product.id, deletedAt: null }, select: { sortOrder: true } });
      if (rows.length >= MAX_PRODUCT_IMAGES) {
        const text = msg("productImages.max", { max: MAX_PRODUCT_IMAGES });
        throw new ValidationError({ file: text }, text);
      }
      const row = await tx.productImage.create({
        data: {
          productId: product.id,
          contentType: type,
          byteSize: bytes.byteLength,
          sha256: createHash("sha256").update(bytes).digest("hex"),
          storageKey: key,
          sortOrder: Math.max(0, ...rows.map((r) => r.sortOrder + 1)),
          uploadedById: user.id,
        },
      });
      await recordAudit(tx, {
        entityType: "PRODUCT",
        entityId: product.id,
        action: "PRODUCT_IMAGE_ADDED",
        summary: msg("erpAudit.imageAdded", { sku: product.sku }),
        changes: { image: row.id, bytes: bytes.byteLength },
        actorId: user.id,
      });
      return { id: row.id, url: productImageUrl(row.id) };
    });
  } catch (e) {
    await discardFile(key).catch(() => undefined);
    throw e;
  }
}

export async function readProductImage(user: CurrentUser, id: string): Promise<{ bytes: Buffer; contentType: string }> {
  if (!hasPermission(user, "products.view") && !hasPermission(user, "inventory.view")) throw new NotFoundError();
  const row = await prisma.productImage.findUnique({ where: { id: checkId(id) }, select: { storageKey: true, contentType: true, deletedAt: true } });
  if (!row || row.deletedAt) throw new NotFoundError();
  return { bytes: await readStoredFile(row.storageKey), contentType: row.contentType };
}

export async function removeProductImage(user: CurrentUser, id: string): Promise<void> {
  assertCan(user, "products.manage");
  await prisma.$transaction(async (tx) => {
    const row = await tx.productImage.findUnique({ where: { id: checkId(id) }, select: { productId: true, deletedAt: true, product: { select: { sku: true } } } });
    if (!row || row.deletedAt) throw new NotFoundError();
    await tx.productImage.update({ where: { id }, data: { deletedAt: new Date(), deletedById: user.id } });
    await recordAudit(tx, {
      entityType: "PRODUCT",
      entityId: row.productId,
      action: "PRODUCT_IMAGE_REMOVED",
      summary: msg("erpAudit.imageRemoved", { sku: row.product.sku }),
      changes: { image: id },
      actorId: user.id,
    });
  });
}

/** Puts an image first (the one shown in lists). */
export async function makeImageFirst(user: CurrentUser, id: string): Promise<ProductImageDTO[]> {
  assertCan(user, "products.manage");
  const row = await prisma.productImage.findUnique({ where: { id: checkId(id) }, select: { productId: true, deletedAt: true } });
  if (!row || row.deletedAt) throw new NotFoundError();
  const rows = await current(row.productId);
  await prisma.productImage.update({ where: { id }, data: { sortOrder: Math.min(...rows.map((r) => r.sortOrder)) - 1 } });
  return listProductImages(user, row.productId);
}
