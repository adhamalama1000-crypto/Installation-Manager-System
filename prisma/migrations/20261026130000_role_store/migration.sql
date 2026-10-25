-- Store keeper role (Aura: المخزن): registers serial-numbered stock and hands it to technicians.
-- Additive; in its own migration because a new enum value cannot be used in the transaction that
-- adds it.
--
-- Rollback (only while no user has the role):
--   ALTER TYPE "Role" RENAME TO "Role_old";
--   CREATE TYPE "Role" AS ENUM ('ADMIN', 'SALES', 'TECHNICIAN', 'VIEWER', 'ACCOUNTANT');
--   ALTER TABLE "users" ALTER COLUMN "role" TYPE "Role" USING "role"::text::"Role";
--   DROP TYPE "Role_old";
--   DELETE FROM _prisma_migrations WHERE migration_name = '20261026130000_role_store';

ALTER TYPE "Role" ADD VALUE IF NOT EXISTS 'STORE';
