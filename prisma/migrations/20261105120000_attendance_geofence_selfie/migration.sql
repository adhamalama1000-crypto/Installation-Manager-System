-- ERP upgrade, attendance: clock-in / clock-out at the company, a customer's site or an approved
-- work location, with a live-camera selfie, configurable geofences, and management review of
-- flagged check-ins. Additive only:
--   * two enum types; work_locations and attendance_reviews: new tables;
--   * check_ins: new nullable columns (site, work location, selfie file, geofence radius used,
--     expected position). Existing check-ins keep NULL there (they were company check-ins, as
--     before). check_ins stays append-only (its trigger is unchanged): a check-in is never
--     edited, a review is a separate, append-only row.
--
-- Rollback (only if none of this is needed any more):
--   DROP TRIGGER attendance_reviews_append_only ON "attendance_reviews"; DROP FUNCTION attendance_reviews_append_only();
--   DROP TRIGGER work_locations_no_delete ON "work_locations"; DROP FUNCTION work_locations_no_delete();
--   ALTER TABLE "check_ins" DROP CONSTRAINT "check_ins_workLocationId_fkey", DROP COLUMN "site", DROP COLUMN "workLocationId",
--     DROP COLUMN "selfieKey", DROP COLUMN "selfieContentType", DROP COLUMN "selfieSha256", DROP COLUMN "geofenceM",
--     DROP COLUMN "expectedLatitude", DROP COLUMN "expectedLongitude";
--   DROP TABLE "attendance_reviews", "work_locations"; DROP TYPE "AttendanceSite", "AttendanceDecision";
--   DELETE FROM _prisma_migrations WHERE migration_name = '20261105120000_attendance_geofence_selfie';

CREATE TYPE "AttendanceSite" AS ENUM ('COMPANY', 'CUSTOMER', 'WORK_LOCATION');
CREATE TYPE "AttendanceDecision" AS ENUM ('ACCEPTED', 'REJECTED');

CREATE TABLE "work_locations" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "nameAr" TEXT,
    "latitude" DECIMAL(9,6) NOT NULL,
    "longitude" DECIMAL(9,6) NOT NULL,
    "radiusM" INTEGER NOT NULL DEFAULT 200,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,
    CONSTRAINT "work_locations_pkey" PRIMARY KEY ("id")
);
ALTER TABLE "work_locations" ADD CONSTRAINT "work_locations_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "work_locations" ADD CONSTRAINT "work_locations_values_check" CHECK ("radiusM" BETWEEN 25 AND 5000 AND "latitude" BETWEEN -90 AND 90 AND "longitude" BETWEEN -180 AND 180);
CREATE OR REPLACE FUNCTION work_locations_no_delete() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'work_locations cannot be deleted; deactivate the location instead';
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER work_locations_no_delete BEFORE DELETE ON "work_locations" FOR EACH ROW EXECUTE FUNCTION work_locations_no_delete();

ALTER TABLE "check_ins" ADD COLUMN "site" "AttendanceSite";
ALTER TABLE "check_ins" ADD COLUMN "workLocationId" TEXT;
ALTER TABLE "check_ins" ADD COLUMN "selfieKey" TEXT;
ALTER TABLE "check_ins" ADD COLUMN "selfieContentType" TEXT;
ALTER TABLE "check_ins" ADD COLUMN "selfieSha256" TEXT;
ALTER TABLE "check_ins" ADD COLUMN "geofenceM" INTEGER;
ALTER TABLE "check_ins" ADD COLUMN "expectedLatitude" DECIMAL(9,6);
ALTER TABLE "check_ins" ADD COLUMN "expectedLongitude" DECIMAL(9,6);
ALTER TABLE "check_ins" ADD CONSTRAINT "check_ins_workLocationId_fkey" FOREIGN KEY ("workLocationId") REFERENCES "work_locations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
CREATE UNIQUE INDEX "check_ins_selfieKey_key" ON "check_ins"("selfieKey");
ALTER TABLE "check_ins" ADD CONSTRAINT "check_ins_selfie_check" CHECK ("selfieKey" IS NULL OR "selfieContentType" IN ('image/jpeg', 'image/png', 'image/webp'));

CREATE TABLE "attendance_reviews" (
    "id" TEXT NOT NULL,
    "checkInId" TEXT NOT NULL,
    "decision" "AttendanceDecision" NOT NULL,
    "note" TEXT,
    "reviewedById" TEXT NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "attendance_reviews_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "attendance_reviews_checkInId_createdAt_idx" ON "attendance_reviews"("checkInId", "createdAt");
ALTER TABLE "attendance_reviews" ADD CONSTRAINT "attendance_reviews_checkInId_fkey" FOREIGN KEY ("checkInId") REFERENCES "check_ins"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "attendance_reviews" ADD CONSTRAINT "attendance_reviews_reviewedById_fkey" FOREIGN KEY ("reviewedById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
-- A rejection always says why.
ALTER TABLE "attendance_reviews" ADD CONSTRAINT "attendance_reviews_note_check" CHECK ("decision" <> 'REJECTED' OR ("note" IS NOT NULL AND length(trim("note")) > 0));
CREATE OR REPLACE FUNCTION attendance_reviews_append_only() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'attendance_reviews are append-only; record a new review instead';
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER attendance_reviews_append_only BEFORE UPDATE OR DELETE ON "attendance_reviews" FOR EACH ROW EXECUTE FUNCTION attendance_reviews_append_only();
