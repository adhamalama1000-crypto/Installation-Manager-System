-- Warehouse Manager role (ERP inventory foundation). Additive; in its own migration because a new
-- enum value cannot be used in the transaction that adds it.
--
-- Rollback (only while no user has the role):
--   PostgreSQL cannot drop an enum value; recreate the type without it (see
--   20261026120000_role_accountant for the steps), then
--   DELETE FROM _prisma_migrations WHERE migration_name = '20261101120000_role_warehouse_manager';

ALTER TYPE "Role" ADD VALUE IF NOT EXISTS 'WAREHOUSE_MANAGER';
