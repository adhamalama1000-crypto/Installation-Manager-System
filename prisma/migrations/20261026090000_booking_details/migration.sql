-- Booking details from the Aura app: visit type, customer confirmation and follow-up visits.
-- Additive only: two new enum types, three new nullable/defaulted columns, one index and one
-- foreign key. Existing appointments keep all their data (visit type unknown = NULL,
-- confirmation = PENDING). Adding a column with a constant default does not rewrite the table.
--
-- Rollback:
--   ALTER TABLE "appointments" DROP CONSTRAINT "appointments_followUpOfId_fkey";
--   DROP INDEX "appointments_followUpOfId_idx";
--   ALTER TABLE "appointments" DROP COLUMN "followUpOfId", DROP COLUMN "customerConfirmation", DROP COLUMN "visitType";
--   DROP TYPE "CustomerConfirmation"; DROP TYPE "VisitType";
--   DELETE FROM _prisma_migrations WHERE migration_name = '20261026090000_booking_details';

-- CreateEnum
CREATE TYPE "VisitType" AS ENUM ('INSPECTION', 'INSTALLATION', 'COMPLETION', 'PROGRAMMING', 'MAINTENANCE');

-- CreateEnum
CREATE TYPE "CustomerConfirmation" AS ENUM ('PENDING', 'CONFIRMED', 'RESCHEDULE_REQUESTED', 'UNREACHABLE');

-- AlterTable
ALTER TABLE "appointments" ADD COLUMN     "customerConfirmation" "CustomerConfirmation" NOT NULL DEFAULT 'PENDING',
ADD COLUMN     "followUpOfId" TEXT,
ADD COLUMN     "visitType" "VisitType";

-- CreateIndex
CREATE INDEX "appointments_followUpOfId_idx" ON "appointments"("followUpOfId");

-- AddForeignKey
ALTER TABLE "appointments" ADD CONSTRAINT "appointments_followUpOfId_fkey" FOREIGN KEY ("followUpOfId") REFERENCES "appointments"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
