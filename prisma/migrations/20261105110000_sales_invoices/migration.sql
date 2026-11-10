-- ERP upgrade: sales invoices, the only source of sales figures. Additive only: one enum type,
-- two new tables, constraints and guard triggers. No existing table or row changes.
--
-- A sale is drafted, then confirmed: confirming posts an ISSUE stock document (linked by
-- stockDocumentId) through the existing posting engine, so stock leaves through the ledger as
-- for any issue. Sales analytics read confirmed invoices only, never stock movements, so
-- transfers, technician issues and adjustments are never counted as sales. A confirmed sale is
-- corrected by cancelling it (with a reason), which reverses its stock document.
--
-- Rollback (only if no sale is needed any more):
--   DROP TRIGGER sales_invoices_guard ON "sales_invoices"; DROP FUNCTION sales_invoices_guard();
--   DROP TRIGGER sales_invoice_lines_guard ON "sales_invoice_lines"; DROP FUNCTION sales_invoice_lines_guard();
--   DROP TABLE "sales_invoice_lines", "sales_invoices"; DROP TYPE "SalesInvoiceStatus";
--   DELETE FROM _prisma_migrations WHERE migration_name = '20261105110000_sales_invoices';

CREATE TYPE "SalesInvoiceStatus" AS ENUM ('DRAFT', 'CONFIRMED', 'CANCELLED');

CREATE TABLE "sales_invoices" (
    "id" TEXT NOT NULL,
    "number" TEXT NOT NULL,
    "status" "SalesInvoiceStatus" NOT NULL DEFAULT 'DRAFT',
    "invoiceDate" DATE NOT NULL,
    "customerId" TEXT,
    "customerName" TEXT NOT NULL,
    "customerPhone" TEXT,
    "appointmentId" TEXT,
    "warehouseId" TEXT NOT NULL,
    "paymentMethod" "PaymentMethod",
    "note" TEXT,
    "subtotal" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "discountTotal" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "total" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "stockDocumentId" TEXT,
    "clientRequestId" TEXT,
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,
    "confirmedAt" TIMESTAMPTZ(3),
    "confirmedById" TEXT,
    "cancelledAt" TIMESTAMPTZ(3),
    "cancelledById" TEXT,
    "cancelReason" TEXT,
    CONSTRAINT "sales_invoices_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "sales_invoices_number_key" ON "sales_invoices"("number");
CREATE UNIQUE INDEX "sales_invoices_stockDocumentId_key" ON "sales_invoices"("stockDocumentId");
CREATE UNIQUE INDEX "sales_invoices_clientRequestId_key" ON "sales_invoices"("clientRequestId");
CREATE INDEX "sales_invoices_status_invoiceDate_idx" ON "sales_invoices"("status", "invoiceDate");
CREATE INDEX "sales_invoices_customerId_idx" ON "sales_invoices"("customerId");
CREATE INDEX "sales_invoices_appointmentId_idx" ON "sales_invoices"("appointmentId");
CREATE INDEX "sales_invoices_warehouseId_invoiceDate_idx" ON "sales_invoices"("warehouseId", "invoiceDate");
CREATE INDEX "sales_invoices_createdById_invoiceDate_idx" ON "sales_invoices"("createdById", "invoiceDate");

CREATE TABLE "sales_invoice_lines" (
    "id" TEXT NOT NULL,
    "invoiceId" TEXT NOT NULL,
    "lineNo" INTEGER NOT NULL,
    "productId" TEXT NOT NULL,
    "quantity" DECIMAL(14,3) NOT NULL,
    "unitPrice" DECIMAL(12,2) NOT NULL,
    "discount" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "lineTotal" DECIMAL(12,2) NOT NULL,
    "unitCost" DECIMAL(14,4),
    "serials" TEXT[] DEFAULT ARRAY[]::TEXT[],
    CONSTRAINT "sales_invoice_lines_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "sales_invoice_lines_invoiceId_lineNo_key" ON "sales_invoice_lines"("invoiceId", "lineNo");
CREATE INDEX "sales_invoice_lines_productId_idx" ON "sales_invoice_lines"("productId");

ALTER TABLE "sales_invoices" ADD CONSTRAINT "sales_invoices_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "customers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "sales_invoices" ADD CONSTRAINT "sales_invoices_appointmentId_fkey" FOREIGN KEY ("appointmentId") REFERENCES "appointments"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "sales_invoices" ADD CONSTRAINT "sales_invoices_warehouseId_fkey" FOREIGN KEY ("warehouseId") REFERENCES "warehouses"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "sales_invoices" ADD CONSTRAINT "sales_invoices_stockDocumentId_fkey" FOREIGN KEY ("stockDocumentId") REFERENCES "stock_documents"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "sales_invoices" ADD CONSTRAINT "sales_invoices_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "sales_invoices" ADD CONSTRAINT "sales_invoices_confirmedById_fkey" FOREIGN KEY ("confirmedById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "sales_invoices" ADD CONSTRAINT "sales_invoices_cancelledById_fkey" FOREIGN KEY ("cancelledById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "sales_invoice_lines" ADD CONSTRAINT "sales_invoice_lines_invoiceId_fkey" FOREIGN KEY ("invoiceId") REFERENCES "sales_invoices"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "sales_invoice_lines" ADD CONSTRAINT "sales_invoice_lines_productId_fkey" FOREIGN KEY ("productId") REFERENCES "products"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "sales_invoices" ADD CONSTRAINT "sales_invoices_amounts_check" CHECK ("subtotal" >= 0 AND "discountTotal" >= 0 AND "total" >= 0 AND "total" = "subtotal" - "discountTotal");
-- A confirmed sale has its stock document; a cancelled confirmed sale has a reason.
ALTER TABLE "sales_invoices" ADD CONSTRAINT "sales_invoices_status_check" CHECK (
  ("status" <> 'CONFIRMED' OR ("stockDocumentId" IS NOT NULL AND "confirmedAt" IS NOT NULL))
  AND ("status" <> 'CANCELLED' OR "confirmedAt" IS NULL OR "cancelReason" IS NOT NULL)
);
ALTER TABLE "sales_invoice_lines" ADD CONSTRAINT "sales_invoice_lines_values_check" CHECK (
  "quantity" > 0 AND "unitPrice" >= 0 AND "discount" >= 0 AND "lineTotal" >= 0 AND "lineTotal" = round("quantity" * "unitPrice" - "discount", 2)
);

-- A draft changes freely; a confirmed sale only becomes cancelled (its content stays); nothing is deleted.
CREATE OR REPLACE FUNCTION sales_invoices_guard() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'sales_invoices cannot be deleted; cancel the invoice instead';
  END IF;
  IF OLD."status" = 'DRAFT' THEN
    RETURN NEW;
  END IF;
  IF OLD."status" = 'CONFIRMED' AND NEW."status" = 'CANCELLED'
     AND ROW(NEW."number", NEW."invoiceDate", NEW."customerId", NEW."customerName", NEW."customerPhone", NEW."appointmentId", NEW."warehouseId",
             NEW."paymentMethod", NEW."note", NEW."subtotal", NEW."discountTotal", NEW."total", NEW."stockDocumentId", NEW."createdById",
             NEW."createdAt", NEW."confirmedAt", NEW."confirmedById")
         IS NOT DISTINCT FROM
         ROW(OLD."number", OLD."invoiceDate", OLD."customerId", OLD."customerName", OLD."customerPhone", OLD."appointmentId", OLD."warehouseId",
             OLD."paymentMethod", OLD."note", OLD."subtotal", OLD."discountTotal", OLD."total", OLD."stockDocumentId", OLD."createdById",
             OLD."createdAt", OLD."confirmedAt", OLD."confirmedById") THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'sales_invoices: a confirmed or cancelled invoice cannot be changed';
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER sales_invoices_guard BEFORE UPDATE OR DELETE ON "sales_invoices" FOR EACH ROW EXECUTE FUNCTION sales_invoices_guard();

-- Lines change only while the invoice is a draft (unit costs are written in the confirming transaction, before the status changes).
CREATE OR REPLACE FUNCTION sales_invoice_lines_guard() RETURNS trigger AS $$
DECLARE
  inv_status "SalesInvoiceStatus";
BEGIN
  SELECT "status" INTO inv_status FROM "sales_invoices" WHERE "id" = CASE WHEN TG_OP = 'DELETE' THEN OLD."invoiceId" ELSE NEW."invoiceId" END;
  IF inv_status IS DISTINCT FROM 'DRAFT' THEN
    RAISE EXCEPTION 'sales_invoice_lines: lines of a confirmed or cancelled invoice cannot change';
  END IF;
  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER sales_invoice_lines_guard BEFORE INSERT OR UPDATE OR DELETE ON "sales_invoice_lines" FOR EACH ROW EXECUTE FUNCTION sales_invoice_lines_guard();
