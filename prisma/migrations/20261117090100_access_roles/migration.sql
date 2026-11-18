-- Custom roles (Admin-defined permission sets). Additive only:
--   * access_roles: new table. A role is deactivated, never deleted (trigger).
--   * users.accessRoleId: new nullable column (metadata-only); existing users keep exactly their
--     role's permissions until an Admin gives them a custom role.
--
-- Rollback (only if no custom role is needed any more):
--   ALTER TABLE "users" DROP CONSTRAINT "users_accessRoleId_fkey", DROP COLUMN "accessRoleId";
--   DROP TRIGGER access_roles_no_delete ON "access_roles"; DROP FUNCTION access_roles_no_delete();
--   DROP TABLE "access_roles";
--   DELETE FROM _prisma_migrations WHERE migration_name = '20261117090100_access_roles';

ALTER TABLE "users" ADD COLUMN "accessRoleId" TEXT;

CREATE TABLE "access_roles" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "nameAr" TEXT,
    "description" TEXT,
    "baseRole" "Role" NOT NULL,
    "permissions" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "dataScopes" JSONB,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdById" TEXT NOT NULL,
    "updatedById" TEXT,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,
    CONSTRAINT "access_roles_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "access_roles_name_check" CHECK (length(trim("name")) > 0),
    -- Admins always have everything; a custom role never stands for one.
    CONSTRAINT "access_roles_base_check" CHECK ("baseRole" <> 'ADMIN')
);

CREATE INDEX "access_roles_baseRole_isActive_idx" ON "access_roles"("baseRole", "isActive");
CREATE INDEX "users_accessRoleId_idx" ON "users"("accessRoleId");

ALTER TABLE "users" ADD CONSTRAINT "users_accessRoleId_fkey" FOREIGN KEY ("accessRoleId") REFERENCES "access_roles"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "access_roles" ADD CONSTRAINT "access_roles_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "access_roles" ADD CONSTRAINT "access_roles_updatedById_fkey" FOREIGN KEY ("updatedById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE OR REPLACE FUNCTION access_roles_no_delete() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'access roles cannot be deleted; deactivate the role instead';
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER access_roles_no_delete BEFORE DELETE ON "access_roles" FOR EACH ROW EXECUTE FUNCTION access_roles_no_delete();
