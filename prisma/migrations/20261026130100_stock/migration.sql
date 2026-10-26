-- Serial-numbered stock (Aura: المخزن / العهدة / الضمان). Additive: an enum and three new tables
-- (product models with warranty months, stock items by serial, and their append-only movement
-- history); nothing existing is changed.
--
-- Rollback:
--   DROP TABLE "stock_movements";
--   DROP FUNCTION stock_movements_block_modification();
--   DROP TABLE "stock_items";
--   DROP TABLE "product_models";
--   DROP TYPE "StockStatus";
--   DELETE FROM _prisma_migrations WHERE migration_name = '20261026130100_stock';

-- CreateEnum
CREATE TYPE "StockStatus" AS ENUM ('IN_STORE', 'WITH_TECHNICIAN', 'INSTALLED', 'RETURNED', 'FAULTY');

-- CreateTable
CREATE TABLE "product_models" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "category" "ProductCategory" NOT NULL,
    "warrantyMonths" INTEGER NOT NULL DEFAULT 12,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "product_models_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "stock_items" (
    "id" TEXT NOT NULL,
    "serial" TEXT NOT NULL,
    "modelId" TEXT NOT NULL,
    "status" "StockStatus" NOT NULL DEFAULT 'IN_STORE',
    "holderId" TEXT,
    "appointmentId" TEXT,
    "installedAt" TIMESTAMPTZ(3),
    "warrantyUntil" DATE,
    "note" TEXT,
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "stock_items_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "stock_movements" (
    "id" TEXT NOT NULL,
    "itemId" TEXT NOT NULL,
    "fromStatus" "StockStatus",
    "toStatus" "StockStatus" NOT NULL,
    "holderId" TEXT,
    "appointmentId" TEXT,
    "note" TEXT,
    "actorId" TEXT NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "stock_movements_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "product_models_name_key" ON "product_models"("name");

-- CreateIndex
CREATE UNIQUE INDEX "stock_items_serial_key" ON "stock_items"("serial");

-- CreateIndex
CREATE INDEX "stock_items_status_modelId_idx" ON "stock_items"("status", "modelId");

-- CreateIndex
CREATE INDEX "stock_items_holderId_status_idx" ON "stock_items"("holderId", "status");

-- CreateIndex
CREATE INDEX "stock_items_appointmentId_idx" ON "stock_items"("appointmentId");

-- CreateIndex
CREATE INDEX "stock_movements_itemId_createdAt_idx" ON "stock_movements"("itemId", "createdAt");

-- AddForeignKey
ALTER TABLE "stock_items" ADD CONSTRAINT "stock_items_modelId_fkey" FOREIGN KEY ("modelId") REFERENCES "product_models"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stock_items" ADD CONSTRAINT "stock_items_holderId_fkey" FOREIGN KEY ("holderId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stock_items" ADD CONSTRAINT "stock_items_appointmentId_fkey" FOREIGN KEY ("appointmentId") REFERENCES "appointments"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stock_items" ADD CONSTRAINT "stock_items_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stock_movements" ADD CONSTRAINT "stock_movements_itemId_fkey" FOREIGN KEY ("itemId") REFERENCES "stock_items"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stock_movements" ADD CONSTRAINT "stock_movements_holderId_fkey" FOREIGN KEY ("holderId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stock_movements" ADD CONSTRAINT "stock_movements_appointmentId_fkey" FOREIGN KEY ("appointmentId") REFERENCES "appointments"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stock_movements" ADD CONSTRAINT "stock_movements_actorId_fkey" FOREIGN KEY ("actorId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Who holds an item and where it is installed always match its status.
ALTER TABLE "stock_items" ADD CONSTRAINT "stock_items_holder_check" CHECK (("status" = 'WITH_TECHNICIAN') = ("holderId" IS NOT NULL));
ALTER TABLE "stock_items" ADD CONSTRAINT "stock_items_installed_check" CHECK (("status" = 'INSTALLED') = ("appointmentId" IS NOT NULL AND "installedAt" IS NOT NULL));
ALTER TABLE "stock_items" ADD CONSTRAINT "stock_items_serial_check" CHECK ("serial" ~ '^[A-Z0-9][A-Z0-9._/-]{0,63}$');
ALTER TABLE "product_models" ADD CONSTRAINT "product_models_warranty_check" CHECK ("warrantyMonths" BETWEEN 0 AND 120);

-- Stock history is append-only.
CREATE OR REPLACE FUNCTION stock_movements_block_modification() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'stock_movements is append-only';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER stock_movements_no_update_delete
  BEFORE UPDATE OR DELETE ON "stock_movements"
  FOR EACH ROW EXECUTE FUNCTION stock_movements_block_modification();
