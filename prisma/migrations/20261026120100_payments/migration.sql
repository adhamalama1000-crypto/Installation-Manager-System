-- Payments and cash custody (Aura: الإجمالي / العربون / المتحصّل / العهدة). Additive: two enums,
-- nullable money columns on appointments, a cash_custody table and CHECK constraints. Existing
-- appointments keep NULL amounts ("not recorded").
--
-- Rollback:
--   DROP TABLE "cash_custody";
--   ALTER TABLE "appointments" DROP CONSTRAINT "appointments_collectedById_fkey";
--   ALTER TABLE "appointments" DROP CONSTRAINT "appointments_money_check";
--   ALTER TABLE "appointments" DROP COLUMN "collectedAmount", DROP COLUMN "collectedAt", DROP COLUMN "collectedById",
--     DROP COLUMN "collectedMethod", DROP COLUMN "depositAmount", DROP COLUMN "depositMethod", DROP COLUMN "extraFee",
--     DROP COLUMN "totalPrice";
--   DROP TYPE "CustodyStatus";
--   DROP TYPE "PaymentMethod";
--   DELETE FROM _prisma_migrations WHERE migration_name = '20261026120100_payments';

-- CreateEnum
CREATE TYPE "PaymentMethod" AS ENUM ('CASH', 'INSTAPAY', 'VODAFONE_CASH', 'BANK_TRANSFER');

-- CreateEnum
CREATE TYPE "CustodyStatus" AS ENUM ('HELD', 'RECEIVED', 'VOID');

-- AlterTable
ALTER TABLE "appointments" ADD COLUMN     "collectedAmount" DECIMAL(12,2),
ADD COLUMN     "collectedAt" TIMESTAMPTZ(3),
ADD COLUMN     "collectedById" TEXT,
ADD COLUMN     "collectedMethod" "PaymentMethod",
ADD COLUMN     "depositAmount" DECIMAL(12,2),
ADD COLUMN     "depositMethod" "PaymentMethod",
ADD COLUMN     "extraFee" DECIMAL(12,2),
ADD COLUMN     "totalPrice" DECIMAL(12,2);

-- CreateTable
CREATE TABLE "cash_custody" (
    "id" TEXT NOT NULL,
    "appointmentId" TEXT NOT NULL,
    "technicianId" TEXT NOT NULL,
    "amount" DECIMAL(12,2) NOT NULL,
    "status" "CustodyStatus" NOT NULL DEFAULT 'HELD',
    "collectedAt" TIMESTAMPTZ(3) NOT NULL,
    "receivedById" TEXT,
    "receivedAt" TIMESTAMPTZ(3),
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "cash_custody_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "cash_custody_appointmentId_key" ON "cash_custody"("appointmentId");

-- CreateIndex
CREATE INDEX "cash_custody_technicianId_status_idx" ON "cash_custody"("technicianId", "status");

-- CreateIndex
CREATE INDEX "cash_custody_status_collectedAt_idx" ON "cash_custody"("status", "collectedAt");

-- AddForeignKey
ALTER TABLE "appointments" ADD CONSTRAINT "appointments_collectedById_fkey" FOREIGN KEY ("collectedById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "cash_custody" ADD CONSTRAINT "cash_custody_appointmentId_fkey" FOREIGN KEY ("appointmentId") REFERENCES "appointments"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "cash_custody" ADD CONSTRAINT "cash_custody_technicianId_fkey" FOREIGN KEY ("technicianId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "cash_custody" ADD CONSTRAINT "cash_custody_receivedById_fkey" FOREIGN KEY ("receivedById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Amounts are never negative and a deposit never exceeds the price.
ALTER TABLE "appointments" ADD CONSTRAINT "appointments_money_check" CHECK (
  ("totalPrice" IS NULL OR "totalPrice" >= 0)
  AND ("depositAmount" IS NULL OR ("depositAmount" >= 0 AND "totalPrice" IS NOT NULL AND "depositAmount" <= "totalPrice"))
  AND ("extraFee" IS NULL OR "extraFee" >= 0)
  AND ("collectedAmount" IS NULL OR "collectedAmount" >= 0)
);
ALTER TABLE "cash_custody" ADD CONSTRAINT "cash_custody_amount_check" CHECK ("amount" >= 0);
-- A receipt is recorded together with who received it.
ALTER TABLE "cash_custody" ADD CONSTRAINT "cash_custody_received_check" CHECK (("status" = 'RECEIVED') = ("receivedAt" IS NOT NULL AND "receivedById" IS NOT NULL));
