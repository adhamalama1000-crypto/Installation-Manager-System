-- Warehouse items and stocktaking upgrade. Additive only:
--   * products: specifications (JSON), lock (lockedAt/By, reason) and archive (archivedAt/By),
--     all nullable: no product is locked or archived until someone does it.
--   * stocktakes: planning columns (name, kind, schedule and occurrence, planned start and end,
--     assignees, supervisor, scope, mandatory, instructions, start, postponement, recount round),
--     nullable or with constant defaults. snapshotAt becomes nullable for PLANNED sessions; every
--     existing stocktake keeps its snapshot.
--   * stocktake_lines: damaged quantity and a recount flag.
--   * new tables: stocktake_schedules, stocktake_counts (append-only count history),
--     stocktake_photos (marked as removed, never deleted).
--   * guard functions are replaced with CREATE OR REPLACE (never dropped):
--       - stocktakes_guard: the snapshot may be set once, when a PLANNED session starts; it still
--         never changes afterwards, and a closed stocktake still never changes;
--       - products_guard: a locked or archived product's information cannot change (stock can
--         still move: averageCost and version stay writable), in addition to the existing rules.
--
-- Rollback (only if none of this is needed any more): drop the three new tables and their
-- triggers, the new columns and enums, restore the previous guard functions from migrations
-- 20261101120100 and 20261105090000, and
--   DELETE FROM _prisma_migrations WHERE migration_name = '20261117100100_stocktake_schedules_item_lock';

CREATE TYPE "StocktakeKind" AS ENUM ('DAILY', 'MONTHLY', 'ANNUAL', 'CUSTOM');

CREATE TYPE "StocktakeRecurrence" AS ENUM ('NONE', 'DAILY', 'WEEKLY', 'MONTHLY', 'YEARLY');

CREATE TYPE "StocktakeScheduleStatus" AS ENUM ('ACTIVE', 'PAUSED', 'ENDED');

ALTER TABLE "products" ADD COLUMN     "archivedAt" TIMESTAMPTZ(3),
ADD COLUMN     "archivedById" TEXT,
ADD COLUMN     "lockReason" TEXT,
ADD COLUMN     "lockedAt" TIMESTAMPTZ(3),
ADD COLUMN     "lockedById" TEXT,
ADD COLUMN     "specifications" JSONB;

ALTER TABLE "stocktake_lines" ADD COLUMN     "damagedQuantity" DECIMAL(14,3),
ADD COLUMN     "recountRequested" BOOLEAN NOT NULL DEFAULT false;

ALTER TABLE "stocktakes" ADD COLUMN     "assigneeIds" TEXT[] DEFAULT ARRAY[]::TEXT[],
ADD COLUMN     "categoryIds" TEXT[] DEFAULT ARRAY[]::TEXT[],
ADD COLUMN     "instructions" TEXT,
ADD COLUMN     "kind" "StocktakeKind",
ADD COLUMN     "mandatory" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "name" TEXT,
ADD COLUMN     "occurrenceDate" DATE,
ADD COLUMN     "plannedEnd" TIMESTAMPTZ(3),
ADD COLUMN     "plannedStart" TIMESTAMPTZ(3),
ADD COLUMN     "postponeReason" TEXT,
ADD COLUMN     "postponedFrom" TIMESTAMPTZ(3),
ADD COLUMN     "productIds" TEXT[] DEFAULT ARRAY[]::TEXT[],
ADD COLUMN     "round" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "scheduleId" TEXT,
ADD COLUMN     "startedAt" TIMESTAMPTZ(3),
ADD COLUMN     "startedById" TEXT,
ADD COLUMN     "supervisorId" TEXT,
ALTER COLUMN "snapshotAt" DROP NOT NULL;

CREATE TABLE "stocktake_schedules" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "nameAr" TEXT,
    "warehouseId" TEXT NOT NULL,
    "kind" "StocktakeKind" NOT NULL,
    "recurrence" "StocktakeRecurrence" NOT NULL DEFAULT 'NONE',
    "interval" INTEGER NOT NULL DEFAULT 1,
    "startDate" DATE NOT NULL,
    "endDate" DATE,
    "startTime" TEXT NOT NULL,
    "durationMinutes" INTEGER NOT NULL,
    "assigneeIds" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "supervisorId" TEXT,
    "categoryIds" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "productIds" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "mandatory" BOOLEAN NOT NULL DEFAULT false,
    "instructions" TEXT,
    "status" "StocktakeScheduleStatus" NOT NULL DEFAULT 'ACTIVE',
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdById" TEXT NOT NULL,
    "updatedById" TEXT,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "stocktake_schedules_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "stocktake_counts" (
    "id" TEXT NOT NULL,
    "stocktakeId" TEXT NOT NULL,
    "lineId" TEXT NOT NULL,
    "round" INTEGER NOT NULL,
    "countedQuantity" DECIMAL(14,3),
    "countedSerials" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "damagedQuantity" DECIMAL(14,3),
    "reason" TEXT,
    "countedById" TEXT NOT NULL,
    "countedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "stocktake_counts_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "stocktake_photos" (
    "id" TEXT NOT NULL,
    "stocktakeId" TEXT NOT NULL,
    "lineId" TEXT,
    "contentType" TEXT NOT NULL,
    "byteSize" INTEGER NOT NULL,
    "sha256" TEXT NOT NULL,
    "storageKey" TEXT NOT NULL,
    "uploadedById" TEXT NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "deletedAt" TIMESTAMPTZ(3),
    "deletedById" TEXT,

    CONSTRAINT "stocktake_photos_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "stocktake_schedules_status_warehouseId_idx" ON "stocktake_schedules"("status", "warehouseId");

CREATE INDEX "stocktake_counts_stocktakeId_lineId_countedAt_idx" ON "stocktake_counts"("stocktakeId", "lineId", "countedAt");

CREATE UNIQUE INDEX "stocktake_photos_storageKey_key" ON "stocktake_photos"("storageKey");

CREATE INDEX "stocktake_photos_stocktakeId_idx" ON "stocktake_photos"("stocktakeId");

CREATE INDEX "stocktakes_status_plannedStart_idx" ON "stocktakes"("status", "plannedStart");

CREATE UNIQUE INDEX "stocktakes_scheduleId_occurrenceDate_key" ON "stocktakes"("scheduleId", "occurrenceDate");

ALTER TABLE "products" ADD CONSTRAINT "products_lockedById_fkey" FOREIGN KEY ("lockedById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "products" ADD CONSTRAINT "products_archivedById_fkey" FOREIGN KEY ("archivedById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "stocktakes" ADD CONSTRAINT "stocktakes_scheduleId_fkey" FOREIGN KEY ("scheduleId") REFERENCES "stocktake_schedules"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "stocktakes" ADD CONSTRAINT "stocktakes_supervisorId_fkey" FOREIGN KEY ("supervisorId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "stocktakes" ADD CONSTRAINT "stocktakes_startedById_fkey" FOREIGN KEY ("startedById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "stocktake_schedules" ADD CONSTRAINT "stocktake_schedules_warehouseId_fkey" FOREIGN KEY ("warehouseId") REFERENCES "warehouses"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "stocktake_schedules" ADD CONSTRAINT "stocktake_schedules_supervisorId_fkey" FOREIGN KEY ("supervisorId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "stocktake_schedules" ADD CONSTRAINT "stocktake_schedules_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "stocktake_schedules" ADD CONSTRAINT "stocktake_schedules_updatedById_fkey" FOREIGN KEY ("updatedById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "stocktake_counts" ADD CONSTRAINT "stocktake_counts_stocktakeId_fkey" FOREIGN KEY ("stocktakeId") REFERENCES "stocktakes"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "stocktake_counts" ADD CONSTRAINT "stocktake_counts_lineId_fkey" FOREIGN KEY ("lineId") REFERENCES "stocktake_lines"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "stocktake_counts" ADD CONSTRAINT "stocktake_counts_countedById_fkey" FOREIGN KEY ("countedById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "stocktake_photos" ADD CONSTRAINT "stocktake_photos_stocktakeId_fkey" FOREIGN KEY ("stocktakeId") REFERENCES "stocktakes"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "stocktake_photos" ADD CONSTRAINT "stocktake_photos_lineId_fkey" FOREIGN KEY ("lineId") REFERENCES "stocktake_lines"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "stocktake_photos" ADD CONSTRAINT "stocktake_photos_uploadedById_fkey" FOREIGN KEY ("uploadedById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "stocktake_photos" ADD CONSTRAINT "stocktake_photos_deletedById_fkey" FOREIGN KEY ("deletedById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


ALTER TABLE "stocktake_schedules" ADD CONSTRAINT "stocktake_schedules_name_check" CHECK (length(trim("name")) > 0);
ALTER TABLE "stocktake_schedules" ADD CONSTRAINT "stocktake_schedules_time_check" CHECK ("startTime" ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$');
ALTER TABLE "stocktake_schedules" ADD CONSTRAINT "stocktake_schedules_numbers_check" CHECK ("interval" BETWEEN 1 AND 366 AND "durationMinutes" BETWEEN 15 AND 10080);
ALTER TABLE "stocktake_schedules" ADD CONSTRAINT "stocktake_schedules_dates_check" CHECK ("endDate" IS NULL OR "endDate" >= "startDate");
ALTER TABLE "stocktakes" ADD CONSTRAINT "stocktakes_planned_check" CHECK ("plannedEnd" IS NULL OR "plannedStart" IS NULL OR "plannedEnd" > "plannedStart");
-- Only a session that never started (planned, or cancelled before it started) has no snapshot.
ALTER TABLE "stocktakes" ADD CONSTRAINT "stocktakes_snapshot_check" CHECK ("snapshotAt" IS NOT NULL OR "status" IN ('PLANNED', 'CANCELLED'));
ALTER TABLE "stocktake_lines" ADD CONSTRAINT "stocktake_lines_damaged_check" CHECK ("damagedQuantity" IS NULL OR ("damagedQuantity" >= 0 AND ("countedQuantity" IS NULL OR "damagedQuantity" <= "countedQuantity")));
ALTER TABLE "stocktake_counts" ADD CONSTRAINT "stocktake_counts_quantities_check" CHECK (("countedQuantity" IS NULL OR "countedQuantity" >= 0) AND ("damagedQuantity" IS NULL OR "damagedQuantity" >= 0));
ALTER TABLE "products" ADD CONSTRAINT "products_archived_inactive_check" CHECK ("archivedAt" IS NULL OR NOT "isActive");

-- The count history is append-only.
CREATE OR REPLACE FUNCTION stocktake_counts_append_only() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'stocktake_counts are append-only';
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER stocktake_counts_append_only BEFORE UPDATE OR DELETE ON "stocktake_counts" FOR EACH ROW EXECUTE FUNCTION stocktake_counts_append_only();

-- Photos are marked as removed, never deleted; their file and owner never change.
CREATE OR REPLACE FUNCTION stocktake_photos_guard() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'stocktake_photos cannot be deleted; mark them as removed';
  END IF;
  IF ROW(NEW."stocktakeId", NEW."lineId", NEW."storageKey", NEW."sha256", NEW."uploadedById", NEW."createdAt")
     IS DISTINCT FROM ROW(OLD."stocktakeId", OLD."lineId", OLD."storageKey", OLD."sha256", OLD."uploadedById", OLD."createdAt") THEN
    RAISE EXCEPTION 'stocktake_photos: only the removal can be recorded';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER stocktake_photos_guard BEFORE UPDATE OR DELETE ON "stocktake_photos" FOR EACH ROW EXECUTE FUNCTION stocktake_photos_guard();

-- Schedules are ended, never deleted.
CREATE OR REPLACE FUNCTION stocktake_schedules_no_delete() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'stocktake_schedules cannot be deleted; end the schedule instead';
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER stocktake_schedules_no_delete BEFORE DELETE ON "stocktake_schedules" FOR EACH ROW EXECUTE FUNCTION stocktake_schedules_no_delete();

-- A closed stocktake (approved, rejected, cancelled) is history; stocktakes are never deleted. The
-- snapshot is taken once: when a PLANNED session starts (it had none); it never changes after.
CREATE OR REPLACE FUNCTION stocktakes_guard() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'stocktakes cannot be deleted; cancel the stocktake instead';
  END IF;
  IF OLD."status" IN ('APPROVED', 'REJECTED', 'CANCELLED') THEN
    RAISE EXCEPTION 'stocktakes: a closed stocktake cannot change';
  END IF;
  IF NEW."number" IS DISTINCT FROM OLD."number" OR NEW."warehouseId" IS DISTINCT FROM OLD."warehouseId"
     OR (NEW."snapshotAt" IS DISTINCT FROM OLD."snapshotAt" AND OLD."snapshotAt" IS NOT NULL)
     OR NEW."createdById" IS DISTINCT FROM OLD."createdById"
     OR NEW."scheduleId" IS DISTINCT FROM OLD."scheduleId" OR NEW."occurrenceDate" IS DISTINCT FROM OLD."occurrenceDate" THEN
    RAISE EXCEPTION 'stocktakes: the warehouse, schedule and snapshot of a stocktake cannot change';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Products are deactivated, never deleted; their unit and serial tracking are fixed once stock
-- has moved, except that mandatory serials may be relaxed to optional serials. A locked or
-- archived product's information cannot change (only its lock / archive state, and the cost and
-- version kept by stock postings).
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
  IF (OLD."lockedAt" IS NOT NULL AND NEW."lockedAt" IS NOT NULL) OR (OLD."archivedAt" IS NOT NULL AND NEW."archivedAt" IS NOT NULL) THEN
    IF ROW(NEW."sku", NEW."barcode", NEW."nameEn", NEW."nameAr", NEW."categoryId", NEW."brandId", NEW."model", NEW."description",
           NEW."unitId", NEW."purchaseCost", NEW."sellingPrice", NEW."minStock", NEW."warrantyMonths", NEW."trackSerials",
           NEW."serialsOptional", NEW."hasVariants", NEW."parentId", NEW."variantNameEn", NEW."variantNameAr", NEW."colorHex",
           NEW."isActive", NEW."specifications")
       IS DISTINCT FROM
       ROW(OLD."sku", OLD."barcode", OLD."nameEn", OLD."nameAr", OLD."categoryId", OLD."brandId", OLD."model", OLD."description",
           OLD."unitId", OLD."purchaseCost", OLD."sellingPrice", OLD."minStock", OLD."warrantyMonths", OLD."trackSerials",
           OLD."serialsOptional", OLD."hasVariants", OLD."parentId", OLD."variantNameEn", OLD."variantNameAr", OLD."colorHex",
           OLD."isActive", OLD."specifications") THEN
      RAISE EXCEPTION 'products: % is locked or archived; unlock it before changing it', OLD."sku" USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- New images cannot be added to a locked or archived product.
CREATE OR REPLACE FUNCTION product_images_locked_product() RETURNS trigger AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM "products" p WHERE p."id" = NEW."productId" AND (p."lockedAt" IS NOT NULL OR p."archivedAt" IS NOT NULL)) THEN
    RAISE EXCEPTION 'product_images: the product is locked or archived' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER product_images_locked_product BEFORE INSERT ON "product_images" FOR EACH ROW EXECUTE FUNCTION product_images_locked_product();
