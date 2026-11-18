-- Adds the Installation manager role (head of installations). Additive: one enum value, in its own
-- migration because PostgreSQL cannot use a new enum value in the transaction that adds it.
-- Nobody gets the role until an Admin assigns it.
--
-- Rollback: an enum value cannot be dropped in place. If no user has the role, recreate the type
-- without it, or leave it unused.
ALTER TYPE "Role" ADD VALUE 'INSTALLATION_MANAGER';
