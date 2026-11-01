-- Booking helpers (Aura phase E): technician specialty, smart-home site readiness, where the lock
-- is, whether an electrician is needed, the quotation link and what was read from it, and
-- 10-minute holds on a technician's time. Additive only: new enums, nullable columns and the
-- slot_holds table (short-lived rows). Existing rows are untouched.
--
-- Rollback (only if none of this data is needed any more):
--   DROP TABLE "slot_holds";
--   ALTER TABLE "appointments" DROP COLUMN "siteFoundation", DROP COLUMN "siteInternet", DROP COLUMN "lockAt",
--     DROP COLUMN "electrician", DROP COLUMN "quoteUrl", DROP COLUMN "quoteData";
--   ALTER TABLE "users" DROP COLUMN "specialty";
--   DROP TYPE "TechnicianSpecialty"; DROP TYPE "ReadinessState"; DROP TYPE "LockLocation"; DROP TYPE "ElectricianNeed";

-- CreateEnum
CREATE TYPE "TechnicianSpecialty" AS ENUM ('LOCK', 'SMART_HOME', 'BOTH');

-- CreateEnum
CREATE TYPE "ReadinessState" AS ENUM ('UNKNOWN', 'NOT_READY', 'READY');

-- CreateEnum
CREATE TYPE "LockLocation" AS ENUM ('COMPANY', 'CUSTOMER', 'UNDECIDED');

-- CreateEnum
CREATE TYPE "ElectricianNeed" AS ENUM ('CUSTOMER_PROVIDES', 'COMPANY_PROVIDES', 'NOT_NEEDED');

-- AlterTable
ALTER TABLE "appointments" ADD COLUMN     "electrician" "ElectricianNeed",
ADD COLUMN     "lockAt" "LockLocation",
ADD COLUMN     "quoteData" JSONB,
ADD COLUMN     "quoteUrl" TEXT,
ADD COLUMN     "siteFoundation" "ReadinessState",
ADD COLUMN     "siteInternet" "ReadinessState";

-- AlterTable
ALTER TABLE "users" ADD COLUMN     "specialty" "TechnicianSpecialty";

-- CreateTable
CREATE TABLE "slot_holds" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "technicianId" TEXT NOT NULL,
    "startsAt" TIMESTAMPTZ(3) NOT NULL,
    "endsAt" TIMESTAMPTZ(3) NOT NULL,
    "expiresAt" TIMESTAMPTZ(3) NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "slot_holds_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "slot_holds_technicianId_expiresAt_idx" ON "slot_holds"("technicianId", "expiresAt");

-- CreateIndex
CREATE INDEX "slot_holds_userId_idx" ON "slot_holds"("userId");

-- AddForeignKey
ALTER TABLE "slot_holds" ADD CONSTRAINT "slot_holds_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "slot_holds" ADD CONSTRAINT "slot_holds_technicianId_fkey" FOREIGN KEY ("technicianId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;


ALTER TABLE "slot_holds" ADD CONSTRAINT "slot_holds_times_check" CHECK ("endsAt" > "startsAt" AND "expiresAt" > "createdAt");
ALTER TABLE "appointments" ADD CONSTRAINT "appointments_quoteUrl_check" CHECK ("quoteUrl" IS NULL OR (length("quoteUrl") <= 500 AND "quoteUrl" ~ '^https?://'));
