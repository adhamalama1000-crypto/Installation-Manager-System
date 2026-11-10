-- ERP upgrade, products: variants, optional serial numbers, category codes for automatic SKUs,
-- and product images. Additive only:
--   * products: new nullable columns, or NOT NULL columns with a constant default. PostgreSQL 11+
--     adds those without rewriting rows, so no existing product row is updated and no trigger
--     fires. Existing products become "standalone" products (no parent, no variants, serial mode
--     unchanged: trackSerials true = mandatory serials, as before).
--   * catalog_categories.code: new nullable column (optional SKU prefix).
--   * product_images: new table.
--   * New CHECK constraints only constrain the new columns, so every existing row satisfies them.
--   * products_guard is replaced (CREATE OR REPLACE): it keeps every rule it had and additionally
--     allows relaxing mandatory serials to optional serials (every recorded serial stays valid).
--   * New trigger: no ledger movement may be written for a product that has variants (its
--     variants hold the stock). No existing movement is touched.
--
-- Rollback (only if no variant, image or category code is needed any more):
--   DROP TRIGGER inventory_movements_variant_parent ON "inventory_movements";
--   DROP FUNCTION inventory_movements_variant_parent();
--   DROP TRIGGER product_images_guard ON "product_images"; DROP FUNCTION product_images_guard();
--   DROP TABLE "product_images";
--   (restore products_guard from 20261101120100_inventory_foundation)
--   ALTER TABLE "products" DROP CONSTRAINT "products_variant_check", DROP CONSTRAINT "products_parent_self_check",
--     DROP CONSTRAINT "products_color_check", DROP CONSTRAINT "products_serial_mode_check",
--     DROP CONSTRAINT "products_parentId_fkey", DROP COLUMN "parentId", DROP COLUMN "hasVariants",
--     DROP COLUMN "variantNameEn", DROP COLUMN "variantNameAr", DROP COLUMN "colorHex", DROP COLUMN "serialsOptional";
--   ALTER TABLE "catalog_categories" DROP CONSTRAINT "catalog_categories_code_check", DROP COLUMN "code";
--   DELETE FROM _prisma_migrations WHERE migration_name = '20261105090000_product_variants';

-- Products: variants and optional serials.
ALTER TABLE "products" ADD COLUMN "parentId" TEXT;
ALTER TABLE "products" ADD COLUMN "hasVariants" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "products" ADD COLUMN "variantNameEn" TEXT;
ALTER TABLE "products" ADD COLUMN "variantNameAr" TEXT;
ALTER TABLE "products" ADD COLUMN "colorHex" TEXT;
ALTER TABLE "products" ADD COLUMN "serialsOptional" BOOLEAN NOT NULL DEFAULT false;

ALTER TABLE "products" ADD CONSTRAINT "products_parentId_fkey" FOREIGN KEY ("parentId") REFERENCES "products"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
CREATE INDEX "products_parentId_idx" ON "products"("parentId");

-- A variant has its variant names and no variants of its own; a product is never its own parent.
ALTER TABLE "products" ADD CONSTRAINT "products_variant_check" CHECK (
  "parentId" IS NULL OR (NOT "hasVariants" AND "variantNameEn" IS NOT NULL AND "variantNameAr" IS NOT NULL)
);
ALTER TABLE "products" ADD CONSTRAINT "products_parent_self_check" CHECK ("parentId" IS NULL OR "parentId" <> "id");
ALTER TABLE "products" ADD CONSTRAINT "products_color_check" CHECK ("colorHex" IS NULL OR "colorHex" ~ '^#[0-9A-F]{6}$');
-- Serial mode: trackSerials = mandatory, serialsOptional = optional, neither = none.
ALTER TABLE "products" ADD CONSTRAINT "products_serial_mode_check" CHECK (NOT ("trackSerials" AND "serialsOptional"));

-- Category code: optional prefix for automatic SKUs (LCK-00001).
ALTER TABLE "catalog_categories" ADD COLUMN "code" TEXT;
ALTER TABLE "catalog_categories" ADD CONSTRAINT "catalog_categories_code_check" CHECK ("code" IS NULL OR "code" ~ '^[A-Z][A-Z0-9]{1,5}$');
CREATE UNIQUE INDEX "catalog_categories_code_key" ON "catalog_categories"("code");

-- Product images (the bytes live in file storage, like visit photos). Removing one only marks it.
CREATE TABLE "product_images" (
    "id" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "contentType" TEXT NOT NULL,
    "byteSize" INTEGER NOT NULL,
    "sha256" TEXT NOT NULL,
    "storageKey" TEXT NOT NULL,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "uploadedById" TEXT NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "deletedAt" TIMESTAMPTZ(3),
    "deletedById" TEXT,
    CONSTRAINT "product_images_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "product_images_storageKey_key" ON "product_images"("storageKey");
CREATE INDEX "product_images_productId_sortOrder_idx" ON "product_images"("productId", "sortOrder");
ALTER TABLE "product_images" ADD CONSTRAINT "product_images_productId_fkey" FOREIGN KEY ("productId") REFERENCES "products"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "product_images" ADD CONSTRAINT "product_images_uploadedById_fkey" FOREIGN KEY ("uploadedById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "product_images" ADD CONSTRAINT "product_images_deletedById_fkey" FOREIGN KEY ("deletedById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "product_images" ADD CONSTRAINT "product_images_type_check" CHECK ("contentType" IN ('image/jpeg', 'image/png', 'image/webp'));

-- Image rows are never deleted; only the order and the "removed" mark change.
CREATE OR REPLACE FUNCTION product_images_guard() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'product_images cannot be deleted; mark the image removed instead';
  END IF;
  IF ROW(NEW."productId", NEW."contentType", NEW."byteSize", NEW."sha256", NEW."storageKey", NEW."uploadedById", NEW."createdAt")
       IS DISTINCT FROM ROW(OLD."productId", OLD."contentType", OLD."byteSize", OLD."sha256", OLD."storageKey", OLD."uploadedById", OLD."createdAt")
     OR (OLD."deletedAt" IS NOT NULL AND NEW."deletedAt" IS DISTINCT FROM OLD."deletedAt") THEN
    RAISE EXCEPTION 'product_images: only the order and the removal of an image can change';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER product_images_guard
  BEFORE UPDATE OR DELETE ON "product_images"
  FOR EACH ROW EXECUTE FUNCTION product_images_guard();

-- Products are deactivated, never deleted; their unit and serial tracking are fixed once stock
-- has moved, except that mandatory serials may be relaxed to optional serials.
CREATE OR REPLACE FUNCTION products_guard() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'products cannot be deleted; deactivate the product instead';
  END IF;
  IF (NEW."unitId" IS DISTINCT FROM OLD."unitId"
      OR (NEW."trackSerials" IS DISTINCT FROM OLD."trackSerials"
          AND NOT (OLD."trackSerials" AND NOT NEW."trackSerials" AND NEW."serialsOptional")))
     AND EXISTS (SELECT 1 FROM "inventory_movements" m WHERE m."productId" = OLD."id") THEN
    RAISE EXCEPTION 'products: the unit and serial tracking cannot change once the product has stock movements';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- A product with variants holds no stock: its variants do.
CREATE OR REPLACE FUNCTION inventory_movements_variant_parent() RETURNS trigger AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM "products" p WHERE p."id" = NEW."productId" AND p."hasVariants") THEN
    RAISE EXCEPTION 'inventory_movements: product % has variants; stock moves on its variants', NEW."productId"
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER inventory_movements_variant_parent
  BEFORE INSERT ON "inventory_movements"
  FOR EACH ROW EXECUTE FUNCTION inventory_movements_variant_parent();
