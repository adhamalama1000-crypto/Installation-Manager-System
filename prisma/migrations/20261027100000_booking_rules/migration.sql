-- Booking rules from the legacy system: site readiness, internet and equipment location on a
-- booking, technician specialty, and short slot holds while a booking is being made.
-- Additive only: new enums, nullable columns and a new table. Existing rows keep NULL ("not
-- recorded").
--
-- Rollback:
--   DROP TABLE "slot_holds";
--   ALTER TABLE "appointments" DROP COLUMN "siteReadiness", DROP COLUMN "internetStatus", DROP COLUMN "equipmentAt";
--   ALTER TABLE "users" DROP COLUMN "specialty";
--   DROP TYPE "SiteReadiness"; DROP TYPE "InternetStatus"; DROP TYPE "EquipmentLocation"; DROP TYPE "Specialty";
--   DELETE FROM _prisma_migrations WHERE migration_name = '20261027100000_booking_rules';

CREATE TYPE "SiteReadiness" AS ENUM ('UNKNOWN', 'NOT_READY', 'PARTIAL', 'READY', 'NOT_NEEDED');
CREATE TYPE "InternetStatus" AS ENUM ('UNKNOWN', 'WORKING', 'NOT_WORKING', 'NOT_AVAILABLE', 'NOT_NEEDED');
CREATE TYPE "EquipmentLocation" AS ENUM ('OFFICE', 'CUSTOMER', 'UNDECIDED');
CREATE TYPE "Specialty" AS ENUM ('BOTH', 'LOCK', 'SMART_HOME');

ALTER TABLE "appointments" ADD COLUMN "siteReadiness" "SiteReadiness";
ALTER TABLE "appointments" ADD COLUMN "internetStatus" "InternetStatus";
ALTER TABLE "appointments" ADD COLUMN "equipmentAt" "EquipmentLocation";

ALTER TABLE "users" ADD COLUMN "specialty" "Specialty";

CREATE TABLE "slot_holds" (
    "id" TEXT NOT NULL,
    "technicianId" TEXT NOT NULL,
    "heldById" TEXT NOT NULL,
    "startsAt" TIMESTAMPTZ(3) NOT NULL,
    "endsAt" TIMESTAMPTZ(3) NOT NULL,
    "expiresAt" TIMESTAMPTZ(3) NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "slot_holds_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "slot_holds_range_check" CHECK ("endsAt" > "startsAt")
);

CREATE INDEX "slot_holds_technicianId_startsAt_idx" ON "slot_holds"("technicianId", "startsAt");
CREATE INDEX "slot_holds_heldById_idx" ON "slot_holds"("heldById");
CREATE INDEX "slot_holds_expiresAt_idx" ON "slot_holds"("expiresAt");

ALTER TABLE "slot_holds" ADD CONSTRAINT "slot_holds_technicianId_fkey" FOREIGN KEY ("technicianId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "slot_holds" ADD CONSTRAINT "slot_holds_heldById_fkey" FOREIGN KEY ("heldById") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
