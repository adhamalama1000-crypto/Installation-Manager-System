-- ERP upgrade, work evidence: videos as visit attachments. One new enum value, in its own
-- migration because PostgreSQL cannot use an enum value in the transaction that adds it.
-- Nothing else changes. Rollback: enum values cannot be dropped in PostgreSQL; an unused value is harmless.
ALTER TYPE "AttachmentKind" ADD VALUE IF NOT EXISTS 'VIDEO';
