-- ERP upgrade, attendance: the visit a clock-in at a customer's site relates to. Kept apart from
-- check_ins.appointmentId, which the existing check_ins_visit_check reserves for visit stages
-- (that rule is unchanged). Additive only: one nullable column, its foreign key and an index;
-- existing rows keep NULL.
--
-- Rollback: ALTER TABLE "check_ins" DROP CONSTRAINT "check_ins_relatedAppointmentId_fkey", DROP COLUMN "relatedAppointmentId";
--   DELETE FROM _prisma_migrations WHERE migration_name = '20261105120100_check_in_related_visit';

ALTER TABLE "check_ins" ADD COLUMN "relatedAppointmentId" TEXT;
ALTER TABLE "check_ins" ADD CONSTRAINT "check_ins_relatedAppointmentId_fkey" FOREIGN KEY ("relatedAppointmentId") REFERENCES "appointments"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
CREATE INDEX "check_ins_relatedAppointmentId_idx" ON "check_ins"("relatedAppointmentId");
