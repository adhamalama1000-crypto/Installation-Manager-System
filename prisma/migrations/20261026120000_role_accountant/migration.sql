-- Accountant role (Aura: محاسب): receives technicians' cash and sees the finance statement.
-- Additive; in its own migration because a new enum value cannot be used in the transaction that
-- adds it.
--
-- Rollback (only while no user has the role):
--   PostgreSQL cannot drop an enum value; recreate the type without it:
--   ALTER TYPE "Role" RENAME TO "Role_old";
--   CREATE TYPE "Role" AS ENUM ('ADMIN', 'SALES', 'TECHNICIAN', 'VIEWER');
--   ALTER TABLE "users" ALTER COLUMN "role" TYPE "Role" USING "role"::text::"Role";
--   DROP TYPE "Role_old";
--   DELETE FROM _prisma_migrations WHERE migration_name = '20261026120000_role_accountant';

ALTER TYPE "Role" ADD VALUE IF NOT EXISTS 'ACCOUNTANT';
