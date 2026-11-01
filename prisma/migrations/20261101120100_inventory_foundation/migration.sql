-- ERP inventory foundation (phase 1): units, categories, brands, products, warehouses and bins,
-- per-location stock balances, numbered stock documents, the immutable inventory ledger, serial
-- locations and physical stocktakes. Additive only: new enums and new tables. No existing table,
-- column or row is changed; the legacy serial custody (product_models / stock_items /
-- stock_movements) keeps working as before.
--
-- The rules that keep the stock ledger trustworthy are enforced here as well as in the
-- application (see the end of this file): append-only movements, documents that cannot change
-- once posted, no negative balances unless the warehouse allows them, and CHECK constraints.
-- Five common units (Piece, Meter, Box, Set, Roll) are inserted; more can be added in the app.
--
-- Rollback (only if none of this data is needed any more; it removes all inventory history):
--   DROP TABLE "stocktake_lines", "product_serials", "inventory_movements", "stock_document_lines",
--     "stock_documents", "stocktakes", "document_sequences", "stock_balances", "warehouse_bins",
--     "warehouses", "products", "brands", "catalog_categories", "units";
--   DROP FUNCTION inventory_movements_block_modification(), stock_documents_guard(),
--     stock_document_lines_guard(), stock_balances_guard(), products_guard(), stocktakes_guard(),
--     stocktake_lines_guard();
--   DROP TYPE "WarehouseKind", "StockDocType", "StockDocStatus", "StockReturnKind",
--     "AdjustDirection", "InventoryMovementType", "StocktakeStatus";
--   DELETE FROM _prisma_migrations WHERE migration_name = '20261101120100_inventory_foundation';

-- Trigram search on product names and SKUs (already enabled by 20261025200000_search_indexes).
CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- CreateEnum
CREATE TYPE "WarehouseKind" AS ENUM ('WAREHOUSE', 'VEHICLE');

-- CreateEnum
CREATE TYPE "StockDocType" AS ENUM ('OPENING', 'RECEIPT', 'ISSUE', 'TRANSFER', 'RETURN', 'ADJUSTMENT');

-- CreateEnum
CREATE TYPE "StockDocStatus" AS ENUM ('DRAFT', 'POSTED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "StockReturnKind" AS ENUM ('CUSTOMER', 'SUPPLIER');

-- CreateEnum
CREATE TYPE "AdjustDirection" AS ENUM ('INCREASE', 'DECREASE');

-- CreateEnum
CREATE TYPE "InventoryMovementType" AS ENUM ('OPENING_BALANCE', 'GOODS_RECEIPT', 'ISSUE', 'TRANSFER_OUT', 'TRANSFER_IN', 'CUSTOMER_RETURN', 'SUPPLIER_RETURN', 'ADJUSTMENT_INCREASE', 'ADJUSTMENT_DECREASE', 'REVERSAL');

-- CreateEnum
CREATE TYPE "StocktakeStatus" AS ENUM ('COUNTING', 'SUBMITTED', 'APPROVED', 'REJECTED', 'CANCELLED');

-- CreateTable
CREATE TABLE "units" (
    "id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "nameEn" TEXT NOT NULL,
    "nameAr" TEXT NOT NULL,
    "allowsFraction" BOOLEAN NOT NULL DEFAULT false,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "units_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "catalog_categories" (
    "id" TEXT NOT NULL,
    "nameEn" TEXT NOT NULL,
    "nameAr" TEXT NOT NULL,
    "parentId" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "catalog_categories_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "brands" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "brands_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "products" (
    "id" TEXT NOT NULL,
    "sku" TEXT NOT NULL,
    "barcode" TEXT,
    "nameEn" TEXT NOT NULL,
    "nameAr" TEXT NOT NULL,
    "categoryId" TEXT,
    "brandId" TEXT,
    "model" TEXT,
    "description" TEXT,
    "unitId" TEXT NOT NULL,
    "purchaseCost" DECIMAL(12,2),
    "sellingPrice" DECIMAL(12,2),
    "averageCost" DECIMAL(14,4) NOT NULL DEFAULT 0,
    "minStock" DECIMAL(14,3) NOT NULL DEFAULT 0,
    "warrantyMonths" INTEGER NOT NULL DEFAULT 0,
    "trackSerials" BOOLEAN NOT NULL DEFAULT false,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdById" TEXT NOT NULL,
    "updatedById" TEXT,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "products_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "warehouses" (
    "id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "nameEn" TEXT NOT NULL,
    "nameAr" TEXT NOT NULL,
    "kind" "WarehouseKind" NOT NULL DEFAULT 'WAREHOUSE',
    "technicianId" TEXT,
    "address" TEXT,
    "allowNegative" BOOLEAN NOT NULL DEFAULT false,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "warehouses_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "warehouse_bins" (
    "id" TEXT NOT NULL,
    "warehouseId" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "warehouse_bins_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "stock_balances" (
    "id" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "warehouseId" TEXT NOT NULL,
    "binId" TEXT,
    "binKey" TEXT NOT NULL DEFAULT '',
    "quantity" DECIMAL(14,3) NOT NULL DEFAULT 0,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "stock_balances_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "document_sequences" (
    "key" TEXT NOT NULL,
    "lastNumber" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "document_sequences_pkey" PRIMARY KEY ("key")
);

-- CreateTable
CREATE TABLE "stock_documents" (
    "id" TEXT NOT NULL,
    "number" TEXT NOT NULL,
    "type" "StockDocType" NOT NULL,
    "status" "StockDocStatus" NOT NULL DEFAULT 'DRAFT',
    "returnKind" "StockReturnKind",
    "fromWarehouseId" TEXT,
    "toWarehouseId" TEXT,
    "documentDate" DATE NOT NULL,
    "reference" TEXT,
    "counterparty" TEXT,
    "note" TEXT,
    "stocktakeId" TEXT,
    "clientRequestId" TEXT,
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,
    "postedAt" TIMESTAMPTZ(3),
    "postedById" TEXT,
    "cancelledAt" TIMESTAMPTZ(3),
    "cancelledById" TEXT,
    "cancelReason" TEXT,

    CONSTRAINT "stock_documents_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "stock_document_lines" (
    "id" TEXT NOT NULL,
    "documentId" TEXT NOT NULL,
    "lineNo" INTEGER NOT NULL,
    "productId" TEXT NOT NULL,
    "quantity" DECIMAL(14,3) NOT NULL,
    "unitCost" DECIMAL(14,4),
    "fromBinId" TEXT,
    "toBinId" TEXT,
    "direction" "AdjustDirection",
    "serials" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "reason" TEXT,

    CONSTRAINT "stock_document_lines_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "inventory_movements" (
    "id" TEXT NOT NULL,
    "documentId" TEXT NOT NULL,
    "lineId" TEXT NOT NULL,
    "type" "InventoryMovementType" NOT NULL,
    "productId" TEXT NOT NULL,
    "warehouseId" TEXT NOT NULL,
    "binId" TEXT,
    "quantity" DECIMAL(14,3) NOT NULL,
    "fromWarehouseId" TEXT,
    "toWarehouseId" TEXT,
    "unitCost" DECIMAL(14,4) NOT NULL,
    "serials" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "reason" TEXT,
    "reversesId" TEXT,
    "balanceAfter" DECIMAL(14,3) NOT NULL,
    "documentDate" DATE NOT NULL,
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "inventory_movements_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "product_serials" (
    "id" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "serial" TEXT NOT NULL,
    "warehouseId" TEXT,
    "binId" TEXT,
    "lastMovementId" TEXT,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "product_serials_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "stocktakes" (
    "id" TEXT NOT NULL,
    "number" TEXT NOT NULL,
    "warehouseId" TEXT NOT NULL,
    "status" "StocktakeStatus" NOT NULL DEFAULT 'COUNTING',
    "note" TEXT,
    "snapshotAt" TIMESTAMPTZ(3) NOT NULL,
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,
    "submittedById" TEXT,
    "submittedAt" TIMESTAMPTZ(3),
    "decidedById" TEXT,
    "decidedAt" TIMESTAMPTZ(3),
    "decisionNote" TEXT,
    "version" INTEGER NOT NULL DEFAULT 1,

    CONSTRAINT "stocktakes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "stocktake_lines" (
    "id" TEXT NOT NULL,
    "stocktakeId" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "binId" TEXT,
    "binKey" TEXT NOT NULL DEFAULT '',
    "systemQuantity" DECIMAL(14,3) NOT NULL,
    "systemSerials" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "countedQuantity" DECIMAL(14,3),
    "countedSerials" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "reason" TEXT,
    "countedById" TEXT,
    "countedAt" TIMESTAMPTZ(3),
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "stocktake_lines_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "units_code_key" ON "units"("code");

-- CreateIndex
CREATE INDEX "catalog_categories_parentId_idx" ON "catalog_categories"("parentId");

-- CreateIndex
CREATE UNIQUE INDEX "brands_name_key" ON "brands"("name");

-- CreateIndex
CREATE UNIQUE INDEX "products_sku_key" ON "products"("sku");

-- CreateIndex
CREATE UNIQUE INDEX "products_barcode_key" ON "products"("barcode");

-- CreateIndex
CREATE INDEX "products_categoryId_idx" ON "products"("categoryId");

-- CreateIndex
CREATE INDEX "products_brandId_idx" ON "products"("brandId");

-- CreateIndex
CREATE INDEX "products_isActive_nameEn_idx" ON "products"("isActive", "nameEn");

-- CreateIndex
CREATE INDEX "products_createdAt_idx" ON "products"("createdAt");

-- CreateIndex
CREATE INDEX "products_nameEn_trgm_idx" ON "products" USING GIN ("nameEn" gin_trgm_ops);

-- CreateIndex
CREATE INDEX "products_nameAr_trgm_idx" ON "products" USING GIN ("nameAr" gin_trgm_ops);

-- CreateIndex
CREATE INDEX "products_sku_trgm_idx" ON "products" USING GIN ("sku" gin_trgm_ops);

-- CreateIndex
CREATE UNIQUE INDEX "warehouses_code_key" ON "warehouses"("code");

-- CreateIndex
CREATE UNIQUE INDEX "warehouses_technicianId_key" ON "warehouses"("technicianId");

-- CreateIndex
CREATE INDEX "warehouses_kind_isActive_idx" ON "warehouses"("kind", "isActive");

-- CreateIndex
CREATE UNIQUE INDEX "warehouse_bins_warehouseId_code_key" ON "warehouse_bins"("warehouseId", "code");

-- CreateIndex
CREATE INDEX "stock_balances_warehouseId_productId_idx" ON "stock_balances"("warehouseId", "productId");

-- CreateIndex
CREATE UNIQUE INDEX "stock_balances_productId_warehouseId_binKey_key" ON "stock_balances"("productId", "warehouseId", "binKey");

-- CreateIndex
CREATE UNIQUE INDEX "stock_documents_number_key" ON "stock_documents"("number");

-- CreateIndex
CREATE UNIQUE INDEX "stock_documents_stocktakeId_key" ON "stock_documents"("stocktakeId");

-- CreateIndex
CREATE UNIQUE INDEX "stock_documents_clientRequestId_key" ON "stock_documents"("clientRequestId");

-- CreateIndex
CREATE INDEX "stock_documents_type_status_documentDate_idx" ON "stock_documents"("type", "status", "documentDate");

-- CreateIndex
CREATE INDEX "stock_documents_status_createdAt_idx" ON "stock_documents"("status", "createdAt");

-- CreateIndex
CREATE INDEX "stock_documents_fromWarehouseId_documentDate_idx" ON "stock_documents"("fromWarehouseId", "documentDate");

-- CreateIndex
CREATE INDEX "stock_documents_toWarehouseId_documentDate_idx" ON "stock_documents"("toWarehouseId", "documentDate");

-- CreateIndex
CREATE INDEX "stock_document_lines_productId_idx" ON "stock_document_lines"("productId");

-- CreateIndex
CREATE UNIQUE INDEX "stock_document_lines_documentId_lineNo_key" ON "stock_document_lines"("documentId", "lineNo");

-- CreateIndex
CREATE UNIQUE INDEX "inventory_movements_reversesId_key" ON "inventory_movements"("reversesId");

-- CreateIndex
CREATE INDEX "inventory_movements_productId_createdAt_idx" ON "inventory_movements"("productId", "createdAt");

-- CreateIndex
CREATE INDEX "inventory_movements_warehouseId_productId_createdAt_idx" ON "inventory_movements"("warehouseId", "productId", "createdAt");

-- CreateIndex
CREATE INDEX "inventory_movements_documentId_idx" ON "inventory_movements"("documentId");

-- CreateIndex
CREATE INDEX "inventory_movements_createdAt_idx" ON "inventory_movements"("createdAt");

-- CreateIndex
CREATE INDEX "product_serials_warehouseId_productId_idx" ON "product_serials"("warehouseId", "productId");

-- CreateIndex
CREATE INDEX "product_serials_serial_idx" ON "product_serials"("serial");

-- CreateIndex
CREATE UNIQUE INDEX "product_serials_productId_serial_key" ON "product_serials"("productId", "serial");

-- CreateIndex
CREATE UNIQUE INDEX "stocktakes_number_key" ON "stocktakes"("number");

-- CreateIndex
CREATE INDEX "stocktakes_warehouseId_status_idx" ON "stocktakes"("warehouseId", "status");

-- CreateIndex
CREATE INDEX "stocktakes_status_createdAt_idx" ON "stocktakes"("status", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "stocktake_lines_stocktakeId_productId_binKey_key" ON "stocktake_lines"("stocktakeId", "productId", "binKey");

-- AddForeignKey
ALTER TABLE "catalog_categories" ADD CONSTRAINT "catalog_categories_parentId_fkey" FOREIGN KEY ("parentId") REFERENCES "catalog_categories"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "products" ADD CONSTRAINT "products_categoryId_fkey" FOREIGN KEY ("categoryId") REFERENCES "catalog_categories"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "products" ADD CONSTRAINT "products_brandId_fkey" FOREIGN KEY ("brandId") REFERENCES "brands"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "products" ADD CONSTRAINT "products_unitId_fkey" FOREIGN KEY ("unitId") REFERENCES "units"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "products" ADD CONSTRAINT "products_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "products" ADD CONSTRAINT "products_updatedById_fkey" FOREIGN KEY ("updatedById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "warehouses" ADD CONSTRAINT "warehouses_technicianId_fkey" FOREIGN KEY ("technicianId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "warehouses" ADD CONSTRAINT "warehouses_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "warehouse_bins" ADD CONSTRAINT "warehouse_bins_warehouseId_fkey" FOREIGN KEY ("warehouseId") REFERENCES "warehouses"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stock_balances" ADD CONSTRAINT "stock_balances_productId_fkey" FOREIGN KEY ("productId") REFERENCES "products"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stock_balances" ADD CONSTRAINT "stock_balances_warehouseId_fkey" FOREIGN KEY ("warehouseId") REFERENCES "warehouses"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stock_balances" ADD CONSTRAINT "stock_balances_binId_fkey" FOREIGN KEY ("binId") REFERENCES "warehouse_bins"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stock_documents" ADD CONSTRAINT "stock_documents_fromWarehouseId_fkey" FOREIGN KEY ("fromWarehouseId") REFERENCES "warehouses"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stock_documents" ADD CONSTRAINT "stock_documents_toWarehouseId_fkey" FOREIGN KEY ("toWarehouseId") REFERENCES "warehouses"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stock_documents" ADD CONSTRAINT "stock_documents_stocktakeId_fkey" FOREIGN KEY ("stocktakeId") REFERENCES "stocktakes"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stock_documents" ADD CONSTRAINT "stock_documents_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stock_documents" ADD CONSTRAINT "stock_documents_postedById_fkey" FOREIGN KEY ("postedById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stock_documents" ADD CONSTRAINT "stock_documents_cancelledById_fkey" FOREIGN KEY ("cancelledById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stock_document_lines" ADD CONSTRAINT "stock_document_lines_documentId_fkey" FOREIGN KEY ("documentId") REFERENCES "stock_documents"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stock_document_lines" ADD CONSTRAINT "stock_document_lines_productId_fkey" FOREIGN KEY ("productId") REFERENCES "products"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stock_document_lines" ADD CONSTRAINT "stock_document_lines_fromBinId_fkey" FOREIGN KEY ("fromBinId") REFERENCES "warehouse_bins"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stock_document_lines" ADD CONSTRAINT "stock_document_lines_toBinId_fkey" FOREIGN KEY ("toBinId") REFERENCES "warehouse_bins"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "inventory_movements" ADD CONSTRAINT "inventory_movements_documentId_fkey" FOREIGN KEY ("documentId") REFERENCES "stock_documents"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "inventory_movements" ADD CONSTRAINT "inventory_movements_lineId_fkey" FOREIGN KEY ("lineId") REFERENCES "stock_document_lines"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "inventory_movements" ADD CONSTRAINT "inventory_movements_productId_fkey" FOREIGN KEY ("productId") REFERENCES "products"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "inventory_movements" ADD CONSTRAINT "inventory_movements_warehouseId_fkey" FOREIGN KEY ("warehouseId") REFERENCES "warehouses"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "inventory_movements" ADD CONSTRAINT "inventory_movements_binId_fkey" FOREIGN KEY ("binId") REFERENCES "warehouse_bins"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "inventory_movements" ADD CONSTRAINT "inventory_movements_reversesId_fkey" FOREIGN KEY ("reversesId") REFERENCES "inventory_movements"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "inventory_movements" ADD CONSTRAINT "inventory_movements_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "product_serials" ADD CONSTRAINT "product_serials_productId_fkey" FOREIGN KEY ("productId") REFERENCES "products"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "product_serials" ADD CONSTRAINT "product_serials_warehouseId_fkey" FOREIGN KEY ("warehouseId") REFERENCES "warehouses"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "product_serials" ADD CONSTRAINT "product_serials_binId_fkey" FOREIGN KEY ("binId") REFERENCES "warehouse_bins"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "product_serials" ADD CONSTRAINT "product_serials_lastMovementId_fkey" FOREIGN KEY ("lastMovementId") REFERENCES "inventory_movements"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stocktakes" ADD CONSTRAINT "stocktakes_warehouseId_fkey" FOREIGN KEY ("warehouseId") REFERENCES "warehouses"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stocktakes" ADD CONSTRAINT "stocktakes_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stocktakes" ADD CONSTRAINT "stocktakes_submittedById_fkey" FOREIGN KEY ("submittedById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stocktakes" ADD CONSTRAINT "stocktakes_decidedById_fkey" FOREIGN KEY ("decidedById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stocktake_lines" ADD CONSTRAINT "stocktake_lines_stocktakeId_fkey" FOREIGN KEY ("stocktakeId") REFERENCES "stocktakes"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stocktake_lines" ADD CONSTRAINT "stocktake_lines_productId_fkey" FOREIGN KEY ("productId") REFERENCES "products"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stocktake_lines" ADD CONSTRAINT "stocktake_lines_binId_fkey" FOREIGN KEY ("binId") REFERENCES "warehouse_bins"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stocktake_lines" ADD CONSTRAINT "stocktake_lines_countedById_fkey" FOREIGN KEY ("countedById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- ---------------------------------------------------------------------------------------------
-- Invariants Prisma cannot express.
-- ---------------------------------------------------------------------------------------------

ALTER TABLE "units" ADD CONSTRAINT "units_code_check" CHECK ("code" ~ '^[A-Z0-9][A-Z0-9_-]{0,15}$');
ALTER TABLE "products" ADD CONSTRAINT "products_sku_check" CHECK ("sku" ~ '^[A-Z0-9][A-Z0-9._/-]{0,63}$');
ALTER TABLE "products" ADD CONSTRAINT "products_barcode_check" CHECK ("barcode" IS NULL OR "barcode" ~ '^[0-9A-Z._-]{1,64}$');
ALTER TABLE "products" ADD CONSTRAINT "products_amounts_check" CHECK (
  ("purchaseCost" IS NULL OR "purchaseCost" >= 0) AND ("sellingPrice" IS NULL OR "sellingPrice" >= 0)
  AND "averageCost" >= 0 AND "minStock" >= 0 AND "warrantyMonths" BETWEEN 0 AND 600);
ALTER TABLE "warehouses" ADD CONSTRAINT "warehouses_code_check" CHECK ("code" ~ '^[A-Z0-9][A-Z0-9_-]{0,19}$');
-- Only a vehicle belongs to a technician.
ALTER TABLE "warehouses" ADD CONSTRAINT "warehouses_technician_check" CHECK ("technicianId" IS NULL OR "kind" = 'VEHICLE');
ALTER TABLE "warehouse_bins" ADD CONSTRAINT "warehouse_bins_code_check" CHECK ("code" ~ '^[A-Z0-9][A-Z0-9_-]{0,19}$');
ALTER TABLE "stock_balances" ADD CONSTRAINT "stock_balances_binKey_check" CHECK ("binKey" = COALESCE("binId", ''));
ALTER TABLE "stocktake_lines" ADD CONSTRAINT "stocktake_lines_binKey_check" CHECK ("binKey" = COALESCE("binId", ''));
-- The system quantity can be negative only where the warehouse allows negative stock; a count never is.
ALTER TABLE "stocktake_lines" ADD CONSTRAINT "stocktake_lines_quantities_check" CHECK ("countedQuantity" IS NULL OR "countedQuantity" >= 0);
ALTER TABLE "document_sequences" ADD CONSTRAINT "document_sequences_lastNumber_check" CHECK ("lastNumber" >= 0);

-- Which warehouses each document type uses: opening / receipt / customer return bring stock in
-- (destination only), issue / supplier return take it out (source only), a transfer has both (the
-- same warehouse only for a move between its bins), an adjustment names the adjusted warehouse.
ALTER TABLE "stock_documents" ADD CONSTRAINT "stock_documents_warehouses_check" CHECK (
  ("type" IN ('OPENING', 'RECEIPT', 'ADJUSTMENT') AND "returnKind" IS NULL AND "fromWarehouseId" IS NULL AND "toWarehouseId" IS NOT NULL)
  OR ("type" = 'ISSUE' AND "returnKind" IS NULL AND "fromWarehouseId" IS NOT NULL AND "toWarehouseId" IS NULL)
  OR ("type" = 'TRANSFER' AND "returnKind" IS NULL AND "fromWarehouseId" IS NOT NULL AND "toWarehouseId" IS NOT NULL)
  OR ("type" = 'RETURN' AND "returnKind" = 'CUSTOMER' AND "fromWarehouseId" IS NULL AND "toWarehouseId" IS NOT NULL)
  OR ("type" = 'RETURN' AND "returnKind" = 'SUPPLIER' AND "fromWarehouseId" IS NOT NULL AND "toWarehouseId" IS NULL));
ALTER TABLE "stock_documents" ADD CONSTRAINT "stock_documents_status_check" CHECK (
  ("status" = 'DRAFT' AND "postedAt" IS NULL AND "postedById" IS NULL AND "cancelledAt" IS NULL)
  OR ("status" = 'POSTED' AND "postedAt" IS NOT NULL AND "postedById" IS NOT NULL AND "cancelledAt" IS NULL)
  OR ("status" = 'CANCELLED' AND "cancelledAt" IS NOT NULL AND "cancelledById" IS NOT NULL
      AND ("postedAt" IS NULL OR length(btrim(COALESCE("cancelReason", ''))) > 0)));
ALTER TABLE "stock_document_lines" ADD CONSTRAINT "stock_document_lines_values_check" CHECK (
  "lineNo" > 0 AND "quantity" > 0 AND ("unitCost" IS NULL OR "unitCost" >= 0));
ALTER TABLE "inventory_movements" ADD CONSTRAINT "inventory_movements_values_check" CHECK (
  "quantity" <> 0 AND "unitCost" >= 0 AND (("type" = 'REVERSAL') = ("reversesId" IS NOT NULL)));

-- The stock ledger is append-only: a mistake is corrected by cancelling the document, which
-- writes REVERSAL movements.
CREATE OR REPLACE FUNCTION inventory_movements_block_modification() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'inventory_movements is append-only';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER inventory_movements_no_update_delete
  BEFORE UPDATE OR DELETE ON "inventory_movements"
  FOR EACH ROW EXECUTE FUNCTION inventory_movements_block_modification();

-- A document can be edited only as a draft. A posted document can only be cancelled (its content
-- stays as it was); documents are never deleted.
CREATE OR REPLACE FUNCTION stock_documents_guard() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'stock_documents cannot be deleted; cancel the document instead';
  END IF;
  IF OLD."status" = 'DRAFT' THEN
    RETURN NEW;
  END IF;
  IF OLD."status" = 'POSTED' AND NEW."status" = 'CANCELLED'
     AND ROW(NEW."number", NEW."type", NEW."returnKind", NEW."fromWarehouseId", NEW."toWarehouseId", NEW."documentDate",
             NEW."reference", NEW."counterparty", NEW."note", NEW."stocktakeId", NEW."clientRequestId", NEW."createdById",
             NEW."createdAt", NEW."postedAt", NEW."postedById")
         IS NOT DISTINCT FROM
         ROW(OLD."number", OLD."type", OLD."returnKind", OLD."fromWarehouseId", OLD."toWarehouseId", OLD."documentDate",
             OLD."reference", OLD."counterparty", OLD."note", OLD."stocktakeId", OLD."clientRequestId", OLD."createdById",
             OLD."createdAt", OLD."postedAt", OLD."postedById") THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'stock_documents: a posted or cancelled document cannot be changed';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER stock_documents_guard
  BEFORE UPDATE OR DELETE ON "stock_documents"
  FOR EACH ROW EXECUTE FUNCTION stock_documents_guard();

CREATE OR REPLACE FUNCTION stock_document_lines_guard() RETURNS trigger AS $$
DECLARE
  doc_status "StockDocStatus";
BEGIN
  IF TG_OP = 'UPDATE' AND NEW."documentId" IS DISTINCT FROM OLD."documentId" THEN
    RAISE EXCEPTION 'stock_document_lines: a line cannot move to another document';
  END IF;
  SELECT "status" INTO doc_status FROM "stock_documents"
    WHERE "id" = CASE WHEN TG_OP = 'DELETE' THEN OLD."documentId" ELSE NEW."documentId" END;
  IF doc_status IS DISTINCT FROM 'DRAFT' THEN
    RAISE EXCEPTION 'stock_document_lines: lines of a posted or cancelled document cannot change';
  END IF;
  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER stock_document_lines_guard
  BEFORE INSERT OR UPDATE OR DELETE ON "stock_document_lines"
  FOR EACH ROW EXECUTE FUNCTION stock_document_lines_guard();

-- No negative stock unless the warehouse's policy allows it (never for serial-tracked products,
-- whose units are individually located). Balances are never deleted.
CREATE OR REPLACE FUNCTION stock_balances_guard() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'stock_balances rows cannot be deleted';
  END IF;
  IF NEW."quantity" < 0 AND (
       EXISTS (SELECT 1 FROM "products" p WHERE p."id" = NEW."productId" AND p."trackSerials")
       OR NOT EXISTS (SELECT 1 FROM "warehouses" w WHERE w."id" = NEW."warehouseId" AND w."allowNegative")) THEN
    RAISE EXCEPTION 'stock_balances: negative stock is not allowed (product %, warehouse %)', NEW."productId", NEW."warehouseId"
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER stock_balances_guard
  BEFORE INSERT OR UPDATE OR DELETE ON "stock_balances"
  FOR EACH ROW EXECUTE FUNCTION stock_balances_guard();

-- Products are deactivated, never deleted; their unit and serial tracking are fixed once stock
-- has moved (the ledger's quantities and serials depend on them).
CREATE OR REPLACE FUNCTION products_guard() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'products cannot be deleted; deactivate the product instead';
  END IF;
  IF (NEW."unitId" IS DISTINCT FROM OLD."unitId" OR NEW."trackSerials" IS DISTINCT FROM OLD."trackSerials")
     AND EXISTS (SELECT 1 FROM "inventory_movements" m WHERE m."productId" = OLD."id") THEN
    RAISE EXCEPTION 'products: the unit and serial tracking cannot change once the product has stock movements';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER products_guard
  BEFORE UPDATE OR DELETE ON "products"
  FOR EACH ROW EXECUTE FUNCTION products_guard();

-- A closed stocktake (approved, rejected, cancelled) is history; stocktakes are never deleted.
CREATE OR REPLACE FUNCTION stocktakes_guard() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'stocktakes cannot be deleted; cancel the stocktake instead';
  END IF;
  IF OLD."status" IN ('APPROVED', 'REJECTED', 'CANCELLED') THEN
    RAISE EXCEPTION 'stocktakes: a closed stocktake cannot change';
  END IF;
  IF NEW."number" IS DISTINCT FROM OLD."number" OR NEW."warehouseId" IS DISTINCT FROM OLD."warehouseId"
     OR NEW."snapshotAt" IS DISTINCT FROM OLD."snapshotAt" OR NEW."createdById" IS DISTINCT FROM OLD."createdById" THEN
    RAISE EXCEPTION 'stocktakes: the warehouse and snapshot of a stocktake cannot change';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER stocktakes_guard
  BEFORE UPDATE OR DELETE ON "stocktakes"
  FOR EACH ROW EXECUTE FUNCTION stocktakes_guard();

-- Counts are entered only while counting; the system snapshot of a line never changes.
CREATE OR REPLACE FUNCTION stocktake_lines_guard() RETURNS trigger AS $$
DECLARE
  take_status "StocktakeStatus";
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'stocktake_lines cannot be deleted';
  END IF;
  IF TG_OP = 'UPDATE' AND ROW(NEW."stocktakeId", NEW."productId", NEW."binKey", NEW."systemQuantity", NEW."systemSerials")
       IS DISTINCT FROM ROW(OLD."stocktakeId", OLD."productId", OLD."binKey", OLD."systemQuantity", OLD."systemSerials") THEN
    RAISE EXCEPTION 'stocktake_lines: the system snapshot of a line cannot change';
  END IF;
  SELECT "status" INTO take_status FROM "stocktakes" WHERE "id" = NEW."stocktakeId";
  IF take_status IS DISTINCT FROM 'COUNTING' THEN
    RAISE EXCEPTION 'stocktake_lines: counts can change only while the stocktake is being counted';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER stocktake_lines_guard
  BEFORE INSERT OR UPDATE OR DELETE ON "stocktake_lines"
  FOR EACH ROW EXECUTE FUNCTION stocktake_lines_guard();

-- Common units of measure. Fixed ids so re-running is harmless; more units are added in the app.
INSERT INTO "units" ("id", "code", "nameEn", "nameAr", "allowsFraction", "isActive", "sortOrder", "createdAt", "updatedAt") VALUES
  ('unit-pcs', 'PCS', 'Piece', 'قطعة', false, true, 10, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  ('unit-m', 'M', 'Meter', 'متر', true, true, 20, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  ('unit-box', 'BOX', 'Box', 'علبة', false, true, 30, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  ('unit-set', 'SET', 'Set', 'طقم', false, true, 40, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  ('unit-roll', 'ROLL', 'Roll', 'لفة', false, true, 50, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
ON CONFLICT ("code") DO NOTHING;
