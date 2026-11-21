-- Sign-in protection (PR-A). Additive only:
--   * auth_rate_limits: atomic fixed-window counters for the sign-in limits (per account, per
--     trusted client address, global) and the "first failure / first block in this window" audit
--     markers. Rows expire and are deleted in the background; nothing references them.
--   * login_attempts: two nullable columns for investigations (outcome, userAgent) and an index on
--     createdAt for the retention clean-up. Existing rows are kept unchanged (outcome stays NULL:
--     the old rows do not say whether a failure was a wrong password or an unknown account).
--
-- Rollback (only if PR-A is reverted):
--   DROP TABLE "auth_rate_limits";
--   DROP INDEX "login_attempts_createdAt_idx";
--   ALTER TABLE "login_attempts" DROP COLUMN "outcome", DROP COLUMN "userAgent";
--   DELETE FROM _prisma_migrations WHERE migration_name = '20261121090000_auth_rate_limits';

-- AlterTable
ALTER TABLE "login_attempts" ADD COLUMN     "outcome" TEXT,
ADD COLUMN     "userAgent" TEXT;

-- CreateTable
CREATE TABLE "auth_rate_limits" (
    "key" TEXT NOT NULL,
    "windowStart" TIMESTAMPTZ(3) NOT NULL,
    "count" INTEGER NOT NULL DEFAULT 0,
    "expiresAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "auth_rate_limits_pkey" PRIMARY KEY ("key","windowStart")
);

-- CreateIndex
CREATE INDEX "auth_rate_limits_expiresAt_idx" ON "auth_rate_limits"("expiresAt");

-- CreateIndex
CREATE INDEX "login_attempts_createdAt_idx" ON "login_attempts"("createdAt");
