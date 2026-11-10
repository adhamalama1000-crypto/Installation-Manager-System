-- ERP upgrade: a supplier master, and stock documents linked to their supplier, customer and
-- booked visit. Additive only:
--   * suppliers: new table (never deleted: deactivated).
--   * stock_documents: three new nullable columns. Existing documents keep NULL (their supplier or
--     customer stays in the free-text "counterparty" column, exactly as before); no row is updated.
--   * stock_documents_guard is replaced (CREATE OR REPLACE) with the same rules, extended to the
--     new columns, so a posted document's supplier, customer and visit cannot change either.
--
-- Rollback (only if no supplier or link is needed any more):
--   (restore stock_documents_guard from 20261101120100_inventory_foundation)
--   ALTER TABLE "stock_documents" DROP CONSTRAINT "stock_documents_supplierId_fkey", DROP CONSTRAINT "stock_documents_customerId_fkey",
--     DROP CONSTRAINT "stock_documents_appointmentId_fkey", DROP COLUMN "supplierId", DROP COLUMN "customerId", DROP COLUMN "appointmentId";
--   DROP TRIGGER suppliers_no_delete ON "suppliers"; DROP FUNCTION suppliers_no_delete(); DROP TABLE "suppliers";
--   DELETE FROM _prisma_migrations WHERE migration_name = '20261105100000_suppliers_document_links';

CREATE TABLE "suppliers" (
    "id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "nameAr" TEXT,
    "contactPerson" TEXT,
    "phone" TEXT,
    "phoneDigits" TEXT,
    "email" TEXT,
    "address" TEXT,
    "taxNumber" TEXT,
    "notes" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,
    CONSTRAINT "suppliers_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "suppliers_code_key" ON "suppliers"("code");
CREATE INDEX "suppliers_isActive_name_idx" ON "suppliers"("isActive", "name");
CREATE INDEX "suppliers_name_trgm_idx" ON "suppliers" USING GIN ("name" gin_trgm_ops);
CREATE INDEX "suppliers_phoneDigits_idx" ON "suppliers"("phoneDigits");
ALTER TABLE "suppliers" ADD CONSTRAINT "suppliers_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "suppliers" ADD CONSTRAINT "suppliers_code_check" CHECK ("code" ~ '^[A-Z0-9][A-Z0-9_-]{0,19}$');

CREATE OR REPLACE FUNCTION suppliers_no_delete() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'suppliers cannot be deleted; deactivate the supplier instead';
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER suppliers_no_delete BEFORE DELETE ON "suppliers" FOR EACH ROW EXECUTE FUNCTION suppliers_no_delete();

-- Links on stock documents.
ALTER TABLE "stock_documents" ADD COLUMN "supplierId" TEXT;
ALTER TABLE "stock_documents" ADD COLUMN "customerId" TEXT;
ALTER TABLE "stock_documents" ADD COLUMN "appointmentId" TEXT;
ALTER TABLE "stock_documents" ADD CONSTRAINT "stock_documents_supplierId_fkey" FOREIGN KEY ("supplierId") REFERENCES "suppliers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "stock_documents" ADD CONSTRAINT "stock_documents_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "customers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "stock_documents" ADD CONSTRAINT "stock_documents_appointmentId_fkey" FOREIGN KEY ("appointmentId") REFERENCES "appointments"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
CREATE INDEX "stock_documents_supplierId_documentDate_idx" ON "stock_documents"("supplierId", "documentDate");
CREATE INDEX "stock_documents_customerId_idx" ON "stock_documents"("customerId");
CREATE INDEX "stock_documents_appointmentId_idx" ON "stock_documents"("appointmentId");

-- The posted-document guard, now covering the new links as well.
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
             NEW."createdAt", NEW."postedAt", NEW."postedById", NEW."supplierId", NEW."customerId", NEW."appointmentId")
         IS NOT DISTINCT FROM
         ROW(OLD."number", OLD."type", OLD."returnKind", OLD."fromWarehouseId", OLD."toWarehouseId", OLD."documentDate",
             OLD."reference", OLD."counterparty", OLD."note", OLD."stocktakeId", OLD."clientRequestId", OLD."createdById",
             OLD."createdAt", OLD."postedAt", OLD."postedById", OLD."supplierId", OLD."customerId", OLD."appointmentId") THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'stock_documents: a posted or cancelled document cannot be changed';
END;
$$ LANGUAGE plpgsql;
