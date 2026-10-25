-- New status kind for "the visit happened but the job needs another visit" (Aura: محتاج زيارة تانية).
-- Its own migration: PostgreSQL does not allow using a new enum value in the transaction that adds it.
-- Rollback: enum values cannot be dropped in place; leaving the unused value is harmless.

-- AlterEnum
ALTER TYPE "StatusKind" ADD VALUE IF NOT EXISTS 'NEEDS_REVISIT';
