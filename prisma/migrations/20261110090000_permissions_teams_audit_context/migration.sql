-- Permissions and audit log upgrade. Additive only:
--   * users: individual permission grants and denials on top of the role (text arrays, empty by
--     default), data scopes per module (JSON, null = the role's defaults) and a team (nullable).
--     Existing users keep exactly their role's permissions and scopes.
--   * teams: new table (for the "team records" scope). Teams are deactivated, never deleted.
--   * audit_logs: module, reason and request context (nullable columns, metadata-only in
--     PostgreSQL 11+, so no existing row is rewritten and the append-only trigger does not fire),
--     and two indexes for the new filters. The append-only trigger is unchanged.
--   * audit_logs: a new statement-level guard refuses TRUNCATE (also when another table's TRUNCATE
--     ... CASCADE would empty it) unless the transaction explicitly sets
--     ims.allow_audit_truncate = 'on'. The application never does; only the test reset and the
--     development-only SEED_FORCE wipe do.
--
-- Rollback (only if none of this is needed any more):
--   DROP TRIGGER audit_logs_no_truncate ON "audit_logs"; DROP FUNCTION audit_logs_block_truncate();
--   DROP TRIGGER teams_no_delete ON "teams"; DROP FUNCTION teams_no_delete();
--   DROP INDEX "audit_logs_module_createdAt_idx", "audit_logs_action_createdAt_idx";
--   ALTER TABLE "audit_logs" DROP COLUMN "context", DROP COLUMN "module", DROP COLUMN "reason";
--   ALTER TABLE "users" DROP CONSTRAINT "users_teamId_fkey", DROP COLUMN "dataScopes", DROP COLUMN "permissionDenies",
--     DROP COLUMN "permissionGrants", DROP COLUMN "teamId";
--   DROP TABLE "teams";
--   DELETE FROM _prisma_migrations WHERE migration_name = '20261110090000_permissions_teams_audit_context';

ALTER TABLE "audit_logs" ADD COLUMN "context" JSONB,
ADD COLUMN "module" TEXT,
ADD COLUMN "reason" TEXT;

ALTER TABLE "users" ADD COLUMN "dataScopes" JSONB,
ADD COLUMN "permissionDenies" TEXT[] DEFAULT ARRAY[]::TEXT[],
ADD COLUMN "permissionGrants" TEXT[] DEFAULT ARRAY[]::TEXT[],
ADD COLUMN "teamId" TEXT;

CREATE TABLE "teams" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "nameAr" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,
    CONSTRAINT "teams_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "teams_name_check" CHECK (length(trim("name")) > 0)
);

CREATE INDEX "audit_logs_module_createdAt_idx" ON "audit_logs"("module", "createdAt");
CREATE INDEX "audit_logs_action_createdAt_idx" ON "audit_logs"("action", "createdAt");
CREATE INDEX "users_teamId_idx" ON "users"("teamId");

ALTER TABLE "users" ADD CONSTRAINT "users_teamId_fkey" FOREIGN KEY ("teamId") REFERENCES "teams"("id") ON DELETE SET NULL ON UPDATE CASCADE;

CREATE OR REPLACE FUNCTION teams_no_delete() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'teams cannot be deleted; deactivate the team instead';
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER teams_no_delete BEFORE DELETE ON "teams" FOR EACH ROW EXECUTE FUNCTION teams_no_delete();

CREATE OR REPLACE FUNCTION audit_logs_block_truncate() RETURNS trigger AS $$
BEGIN
  IF coalesce(current_setting('ims.allow_audit_truncate', true), '') = 'on' THEN
    RETURN NULL;
  END IF;
  RAISE EXCEPTION 'audit_logs is append-only: TRUNCATE is refused';
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER audit_logs_no_truncate BEFORE TRUNCATE ON "audit_logs" FOR EACH STATEMENT EXECUTE FUNCTION audit_logs_block_truncate();
