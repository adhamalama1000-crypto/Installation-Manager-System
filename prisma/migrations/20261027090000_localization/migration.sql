-- Arabic / English interface. Additive: four nullable columns; existing rows keep their text.
-- The default statuses get their Arabic name only where the English name is still the seeded one,
-- so statuses an Admin renamed are left alone (their Arabic name can be set in Settings).
--
-- Rollback:
--   ALTER TABLE "users" DROP CONSTRAINT "users_locale_check";
--   ALTER TABLE "users" DROP COLUMN "locale";
--   ALTER TABLE "appointment_statuses" DROP COLUMN "nameAr";
--   ALTER TABLE "notifications" DROP COLUMN "data";
--   ALTER TABLE "audit_logs" DROP COLUMN "summaryData";
--   DELETE FROM _prisma_migrations WHERE migration_name = '20261027090000_localization';

-- AlterTable
ALTER TABLE "appointment_statuses" ADD COLUMN     "nameAr" TEXT;

-- AlterTable
ALTER TABLE "audit_logs" ADD COLUMN     "summaryData" JSONB;

-- AlterTable
ALTER TABLE "notifications" ADD COLUMN     "data" JSONB;

-- AlterTable
ALTER TABLE "users" ADD COLUMN     "locale" TEXT;

ALTER TABLE "users" ADD CONSTRAINT "users_locale_check" CHECK ("locale" IS NULL OR "locale" IN ('ar', 'en'));

UPDATE "appointment_statuses" SET "nameAr" = CASE "name"
    WHEN 'Scheduled' THEN 'مجدول'
    WHEN 'In Progress' THEN 'قيد التنفيذ'
    WHEN 'Completed' THEN 'تم التنفيذ'
    WHEN 'Postponed/Rescheduled' THEN 'مؤجل / ميعاد جديد'
    WHEN 'Cancelled' THEN 'ملغي'
    WHEN 'Unable to Complete' THEN 'تعذّر التنفيذ'
    WHEN 'Needs another visit' THEN 'محتاج زيارة أخرى'
  END
WHERE "nameAr" IS NULL
  AND "name" IN ('Scheduled', 'In Progress', 'Completed', 'Postponed/Rescheduled', 'Cancelled', 'Unable to Complete', 'Needs another visit');
