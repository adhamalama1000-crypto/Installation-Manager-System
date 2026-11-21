-- Batch 1 (H1/M4): known sign-in devices. Additive only: one new table, nothing existing changes.
--   login_devices: the SHA-256 of a random token kept in an httpOnly cookie (path /api/auth) by a
--   browser that signed in successfully. Sign-ins from such a browser use their own failure counter
--   and the password pool's priority lane, so floods and targeted lockouts cannot lock the real
--   user out. Not a credential. Rows expire (90 days) and are deleted in the background; users
--   keep at most 10. Deleting a user deletes their devices (ON DELETE CASCADE).
--
-- Rollback (only if this change is reverted; the previous app version ignores the table):
--   DROP TABLE "login_devices";
--   DELETE FROM _prisma_migrations WHERE migration_name = '20261121120000_login_devices';

-- CreateTable
CREATE TABLE "login_devices" (
    "tokenHash" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastUsedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "login_devices_pkey" PRIMARY KEY ("tokenHash")
);

-- CreateIndex
CREATE INDEX "login_devices_userId_lastUsedAt_idx" ON "login_devices"("userId", "lastUsedAt");

-- CreateIndex
CREATE INDEX "login_devices_expiresAt_idx" ON "login_devices"("expiresAt");

-- AddForeignKey
ALTER TABLE "login_devices" ADD CONSTRAINT "login_devices_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
