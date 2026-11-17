-- Adds the "Removal / dismantling" visit type. Additive: one enum value, in its own migration
-- because PostgreSQL cannot use a new enum value in the transaction that adds it. No existing
-- appointment changes.
--
-- Rollback: an enum value cannot be dropped in place; leave it unused.
ALTER TYPE "VisitType" ADD VALUE 'REMOVAL';
