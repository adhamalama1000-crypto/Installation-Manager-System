-- Transport expenses and the company car (Aura phase D). Additive only: a new enum, the
-- transport_expenses table, and two columns on appointments (needsCar with a default, carSeq
-- nullable). Existing rows are untouched. The check-in rule for stages without a visit now also
-- allows the car leaving and coming back.
--
-- Rollback (only if none of this data is needed any more):
--   DROP TABLE "transport_expenses";
--   DROP FUNCTION transport_expenses_guard();
--   DROP TYPE "ExpenseStatus";
--   ALTER TABLE "appointments" DROP COLUMN "needsCar", DROP COLUMN "carSeq";
--   ALTER TABLE "check_ins" DROP CONSTRAINT "check_ins_visit_check";
--   ALTER TABLE "check_ins" ADD CONSTRAINT "check_ins_visit_check" CHECK ((("kind" IN ('COMPANY', 'LEAVE')) = ("appointmentId" IS NULL)));

-- CreateEnum
CREATE TYPE "ExpenseStatus" AS ENUM ('PENDING', 'PAID', 'CANCELLED');

-- AlterTable
ALTER TABLE "appointments" ADD COLUMN     "carSeq" INTEGER,
ADD COLUMN     "needsCar" BOOLEAN NOT NULL DEFAULT false;

-- CreateTable
CREATE TABLE "transport_expenses" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "appointmentId" TEXT,
    "day" DATE NOT NULL,
    "amount" DECIMAL(12,2) NOT NULL,
    "note" TEXT,
    "receiptKey" TEXT,
    "receiptContentType" TEXT,
    "status" "ExpenseStatus" NOT NULL DEFAULT 'PENDING',
    "paidAt" TIMESTAMPTZ(3),
    "paidById" TEXT,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "transport_expenses_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "transport_expenses_receiptKey_key" ON "transport_expenses"("receiptKey");

-- CreateIndex
CREATE INDEX "transport_expenses_userId_day_idx" ON "transport_expenses"("userId", "day");

-- CreateIndex
CREATE INDEX "transport_expenses_status_day_idx" ON "transport_expenses"("status", "day");

-- CreateIndex
CREATE INDEX "appointments_needsCar_startsAt_idx" ON "appointments"("needsCar", "startsAt");

-- AddForeignKey
ALTER TABLE "transport_expenses" ADD CONSTRAINT "transport_expenses_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "transport_expenses" ADD CONSTRAINT "transport_expenses_appointmentId_fkey" FOREIGN KEY ("appointmentId") REFERENCES "appointments"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "transport_expenses" ADD CONSTRAINT "transport_expenses_paidById_fkey" FOREIGN KEY ("paidById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


ALTER TABLE "transport_expenses" ADD CONSTRAINT "transport_expenses_amount_check" CHECK ("amount" > 0 AND "amount" <= 100000);
ALTER TABLE "transport_expenses" ADD CONSTRAINT "transport_expenses_paid_check" CHECK (("status" = 'PAID') = ("paidAt" IS NOT NULL) AND ("paidAt" IS NULL) = ("paidById" IS NULL));
ALTER TABLE "transport_expenses" ADD CONSTRAINT "transport_expenses_receipt_check" CHECK (("receiptKey" IS NULL) = ("receiptContentType" IS NULL));
ALTER TABLE "appointments" ADD CONSTRAINT "appointments_carSeq_check" CHECK ("carSeq" IS NULL OR "carSeq" > 0);

ALTER TABLE "check_ins" DROP CONSTRAINT "check_ins_visit_check";
ALTER TABLE "check_ins" ADD CONSTRAINT "check_ins_visit_check" CHECK ((("kind" IN ('COMPANY', 'LEAVE', 'CAR_GO', 'CAR_BACK')) = ("appointmentId" IS NULL)));

-- Expenses are money records: never deleted, and who, when and how much never change.
CREATE FUNCTION transport_expenses_guard() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'transport expenses cannot be deleted; cancel them instead';
  END IF;
  IF NEW."userId" <> OLD."userId" OR NEW."day" <> OLD."day" OR NEW."amount" <> OLD."amount"
     OR NEW."appointmentId" IS DISTINCT FROM OLD."appointmentId" OR NEW."createdAt" <> OLD."createdAt"
     OR (OLD."receiptKey" IS NOT NULL AND NEW."receiptKey" IS DISTINCT FROM OLD."receiptKey")
     OR OLD."status" <> 'PENDING' THEN
    RAISE EXCEPTION 'only a pending expense can change, and only its status or a first receipt';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER transport_expenses_guard BEFORE UPDATE OR DELETE ON "transport_expenses" FOR EACH ROW EXECUTE FUNCTION transport_expenses_guard();
