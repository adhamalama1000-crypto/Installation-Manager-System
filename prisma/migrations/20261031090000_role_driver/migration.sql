-- Driver role and the company car's check-in stages (Aura: سواق, car_go / car_drop / car_pick /
-- car_back). Additive; in its own migration because a new enum value cannot be used in the
-- transaction that adds it.
--
-- Rollback (only while no user has the role and no check-in uses the stages):
--   PostgreSQL cannot drop an enum value; recreate the types without them (see
--   20261026120000_role_accountant for the steps), then
--   DELETE FROM _prisma_migrations WHERE migration_name = '20261031090000_role_driver';

ALTER TYPE "Role" ADD VALUE IF NOT EXISTS 'DRIVER';
ALTER TYPE "CheckInKind" ADD VALUE IF NOT EXISTS 'CAR_GO';
ALTER TYPE "CheckInKind" ADD VALUE IF NOT EXISTS 'CAR_DROP';
ALTER TYPE "CheckInKind" ADD VALUE IF NOT EXISTS 'CAR_PICK';
ALTER TYPE "CheckInKind" ADD VALUE IF NOT EXISTS 'CAR_BACK';
