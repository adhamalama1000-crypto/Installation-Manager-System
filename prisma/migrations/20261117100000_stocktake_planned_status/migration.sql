-- Scheduled stocktakes: a PLANNED status for sessions that have not started (no snapshot, no
-- freeze). Additive: one enum value, in its own migration because PostgreSQL cannot use a new
-- enum value in the transaction that adds it. No existing stocktake changes status.
--
-- Rollback: an enum value cannot be dropped in place; leave it unused.
ALTER TYPE "StocktakeStatus" ADD VALUE 'PLANNED' BEFORE 'COUNTING';
