-- Arabic / English interface. Additive only.
-- Rollback: ALTER TABLE ... DROP COLUMN for each column below (no data outside them depends on it).

ALTER TABLE "users" ADD COLUMN "locale" TEXT;
ALTER TABLE "users" ADD CONSTRAINT "users_locale_check" CHECK ("locale" IS NULL OR "locale" IN ('ar', 'en'));

ALTER TABLE "appointment_statuses" ADD COLUMN "nameAr" TEXT;

ALTER TABLE "notifications" ADD COLUMN "params" JSONB;

-- audit_logs stays append-only (the trigger blocks UPDATE/DELETE of rows, not schema changes).
ALTER TABLE "audit_logs" ADD COLUMN "params" JSONB;

-- Arabic names for the default statuses (repeatable: only fills names that are still empty).
UPDATE "appointment_statuses" SET "nameAr" = CASE "name"
    WHEN 'Scheduled' THEN 'مجدول'
    WHEN 'In Progress' THEN 'قيد التنفيذ'
    WHEN 'Completed' THEN 'تم التنفيذ'
    WHEN 'Postponed/Rescheduled' THEN 'مؤجل'
    WHEN 'Cancelled' THEN 'ملغي'
    WHEN 'Unable to Complete' THEN 'تعذّر الإكمال'
    WHEN 'Needs another visit' THEN 'يحتاج زيارة أخرى'
  END
WHERE "nameAr" IS NULL
  AND "name" IN ('Scheduled', 'In Progress', 'Completed', 'Postponed/Rescheduled', 'Cancelled', 'Unable to Complete', 'Needs another visit');
