-- Field tracking (Aura phase C): technician check-ins with location, the latest position while on
-- the way to a customer, and late alerts already sent. Additive only: a new enum and three new
-- tables. Existing rows are untouched. Company location, working hours and the repeat-visit fee
-- are stored in the existing settings row.
--
-- Rollback (only if none of this data is needed any more):
--   DROP TABLE "alerts_sent";
--   DROP TABLE "technician_positions";
--   DROP TABLE "check_ins";
--   DROP FUNCTION check_ins_append_only();
--   DROP TYPE "CheckInKind";

-- CreateEnum
CREATE TYPE "CheckInKind" AS ENUM ('COMPANY', 'PICKUP', 'READY', 'DEPART', 'ARRIVE', 'START', 'DONE', 'PROBLEM', 'LEAVE');

-- CreateTable
CREATE TABLE "check_ins" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "kind" "CheckInKind" NOT NULL,
    "appointmentId" TEXT,
    "day" DATE NOT NULL,
    "latitude" DECIMAL(9,6),
    "longitude" DECIMAL(9,6),
    "accuracyM" INTEGER,
    "distanceM" INTEGER,
    "etaAt" TIMESTAMPTZ(3),
    "lateMinutes" INTEGER,
    "earlyMinutes" INTEGER,
    "far" BOOLEAN NOT NULL DEFAULT false,
    "reason" TEXT,
    "note" TEXT,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "check_ins_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "technician_positions" (
    "userId" TEXT NOT NULL,
    "latitude" DECIMAL(9,6) NOT NULL,
    "longitude" DECIMAL(9,6) NOT NULL,
    "accuracyM" INTEGER,
    "at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "technician_positions_pkey" PRIMARY KEY ("userId")
);

-- CreateTable
CREATE TABLE "alerts_sent" (
    "day" DATE NOT NULL,
    "key" TEXT NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "alerts_sent_pkey" PRIMARY KEY ("day","key")
);

-- CreateIndex
CREATE INDEX "check_ins_day_userId_idx" ON "check_ins"("day", "userId");

-- CreateIndex
CREATE INDEX "check_ins_appointmentId_kind_idx" ON "check_ins"("appointmentId", "kind");

-- CreateIndex
CREATE INDEX "check_ins_userId_createdAt_idx" ON "check_ins"("userId", "createdAt");

-- AddForeignKey
ALTER TABLE "check_ins" ADD CONSTRAINT "check_ins_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "check_ins" ADD CONSTRAINT "check_ins_appointmentId_fkey" FOREIGN KEY ("appointmentId") REFERENCES "appointments"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "technician_positions" ADD CONSTRAINT "technician_positions_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;


ALTER TABLE "check_ins" ADD CONSTRAINT "check_ins_coordinates_check" CHECK (
  ("latitude" IS NULL) = ("longitude" IS NULL)
  AND ("latitude" IS NULL OR ("latitude" BETWEEN -90 AND 90 AND "longitude" BETWEEN -180 AND 180))
);
ALTER TABLE "check_ins" ADD CONSTRAINT "check_ins_visit_check" CHECK ((("kind" IN ('COMPANY', 'LEAVE')) = ("appointmentId" IS NULL)));
ALTER TABLE "check_ins" ADD CONSTRAINT "check_ins_numbers_check" CHECK (
  ("accuracyM" IS NULL OR "accuracyM" >= 0) AND ("distanceM" IS NULL OR "distanceM" >= 0)
  AND ("lateMinutes" IS NULL OR "lateMinutes" > 0) AND ("earlyMinutes" IS NULL OR "earlyMinutes" > 0)
);
ALTER TABLE "check_ins" ADD CONSTRAINT "check_ins_problem_check" CHECK (("kind" = 'PROBLEM') = ("reason" IS NOT NULL));
ALTER TABLE "technician_positions" ADD CONSTRAINT "technician_positions_coordinates_check" CHECK ("latitude" BETWEEN -90 AND 90 AND "longitude" BETWEEN -180 AND 180);

-- Check-ins are a record of what happened: never changed or deleted.
CREATE FUNCTION check_ins_append_only() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'check-ins are append-only';
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER check_ins_append_only BEFORE UPDATE OR DELETE ON "check_ins" FOR EACH ROW EXECUTE FUNCTION check_ins_append_only();
