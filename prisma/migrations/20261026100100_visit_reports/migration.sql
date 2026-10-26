-- Technicians record the outcome of a visit with a report (Aura: تقرير الزيارة). Additive: three
-- nullable columns and a foreign key; plus the "Needs another visit" status when the database has no
-- status of that kind yet (it can be renamed, recoloured or deactivated in Settings).
--
-- Rollback:
--   ALTER TABLE "appointments" DROP CONSTRAINT "appointments_reportedById_fkey";
--   ALTER TABLE "appointments" DROP COLUMN "reportedAt", DROP COLUMN "reportedById", DROP COLUMN "visitReport";
--   DELETE FROM appointment_statuses WHERE id = 'status_needs_revisit'
--     AND NOT EXISTS (SELECT 1 FROM appointments WHERE "statusId" = 'status_needs_revisit');
--   DELETE FROM _prisma_migrations WHERE migration_name = '20261026100100_visit_reports';

-- AlterTable
ALTER TABLE "appointments" ADD COLUMN     "reportedAt" TIMESTAMPTZ(3),
ADD COLUMN     "reportedById" TEXT,
ADD COLUMN     "visitReport" TEXT;

-- AddForeignKey
ALTER TABLE "appointments" ADD CONSTRAINT "appointments_reportedById_fkey" FOREIGN KEY ("reportedById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Default status for the new kind (only on databases that already have statuses, so a fresh
-- database is still set up entirely by the seed or by an Admin).
INSERT INTO "appointment_statuses" ("id", "name", "kind", "color", "blocksSchedule", "isDefault", "isActive", "sortOrder", "createdAt", "updatedAt")
SELECT 'status_needs_revisit', 'Needs another visit', 'NEEDS_REVISIT', '#EA580C', true, false, true,
       COALESCE((SELECT MAX("sortOrder") FROM "appointment_statuses"), 0) + 5, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
WHERE EXISTS (SELECT 1 FROM "appointment_statuses")
  AND NOT EXISTS (SELECT 1 FROM "appointment_statuses" WHERE "kind" = 'NEEDS_REVISIT' OR "name" = 'Needs another visit');
