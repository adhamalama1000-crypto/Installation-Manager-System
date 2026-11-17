-- Installation scheduling. Additive only:
--   * technician_work_hours: optional working hours per technician and weekday. A technician with
--     no rows keeps today's behaviour (no working-hours restriction). Per weekday a row is a day
--     off (isOff), working hours (start and end), or a working day with no set hours (no times).
--     Rows are updated in place, never deleted; the changes are in the audit log.
--   * reschedule_requests: a technician's request to move an assigned visit. Requests are
--     resolved (done / declined), never deleted.
--
-- Rollback (only if neither is needed any more):
--   DROP TRIGGER reschedule_requests_no_delete ON "reschedule_requests"; DROP FUNCTION reschedule_requests_no_delete();
--   DROP TABLE "reschedule_requests"; DROP TABLE "technician_work_hours"; DROP TYPE "RescheduleRequestStatus";
--   DELETE FROM _prisma_migrations WHERE migration_name = '20261118090100_work_hours_reschedule';

CREATE TYPE "RescheduleRequestStatus" AS ENUM ('OPEN', 'DONE', 'DECLINED');

CREATE TABLE "technician_work_hours" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "weekday" INTEGER NOT NULL,
    "isOff" BOOLEAN NOT NULL DEFAULT false,
    "startTime" TEXT,
    "endTime" TEXT,
    "updatedById" TEXT NOT NULL,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "technician_work_hours_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "reschedule_requests" (
    "id" TEXT NOT NULL,
    "appointmentId" TEXT NOT NULL,
    "requestedById" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "proposedStart" TIMESTAMPTZ(3),
    "status" "RescheduleRequestStatus" NOT NULL DEFAULT 'OPEN',
    "resolvedById" TEXT,
    "resolvedAt" TIMESTAMPTZ(3),
    "resolutionNote" TEXT,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "reschedule_requests_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "technician_work_hours_userId_weekday_key" ON "technician_work_hours"("userId", "weekday");

CREATE INDEX "reschedule_requests_appointmentId_status_idx" ON "reschedule_requests"("appointmentId", "status");

CREATE INDEX "reschedule_requests_status_createdAt_idx" ON "reschedule_requests"("status", "createdAt");

ALTER TABLE "technician_work_hours" ADD CONSTRAINT "technician_work_hours_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "technician_work_hours" ADD CONSTRAINT "technician_work_hours_updatedById_fkey" FOREIGN KEY ("updatedById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "reschedule_requests" ADD CONSTRAINT "reschedule_requests_appointmentId_fkey" FOREIGN KEY ("appointmentId") REFERENCES "appointments"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "reschedule_requests" ADD CONSTRAINT "reschedule_requests_requestedById_fkey" FOREIGN KEY ("requestedById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "reschedule_requests" ADD CONSTRAINT "reschedule_requests_resolvedById_fkey" FOREIGN KEY ("resolvedById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


ALTER TABLE "technician_work_hours" ADD CONSTRAINT "technician_work_hours_weekday_check" CHECK ("weekday" BETWEEN 0 AND 6);
ALTER TABLE "technician_work_hours" ADD CONSTRAINT "technician_work_hours_times_check" CHECK (
  ("startTime" IS NULL AND "endTime" IS NULL)
  OR (NOT "isOff" AND "startTime" ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$' AND "endTime" ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$' AND "endTime" > "startTime"));
ALTER TABLE "reschedule_requests" ADD CONSTRAINT "reschedule_requests_reason_check" CHECK (length(trim("reason")) > 0);
ALTER TABLE "reschedule_requests" ADD CONSTRAINT "reschedule_requests_resolution_check" CHECK (("status" = 'OPEN') = ("resolvedAt" IS NULL));

CREATE OR REPLACE FUNCTION reschedule_requests_no_delete() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'reschedule_requests cannot be deleted';
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER reschedule_requests_no_delete BEFORE DELETE ON "reschedule_requests" FOR EACH ROW EXECUTE FUNCTION reschedule_requests_no_delete();
