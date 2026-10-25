-- Technician leave (Aura: الإجازات / مرضي / غياب). Additive: two enums and a new table; nothing
-- existing is changed. Approved leave blocks bookings for that technician on those company-local
-- dates (enforced in the application, see src/server/services/leaves.ts).
--
-- Rollback:
--   DROP TABLE "technician_leaves";
--   DROP TYPE "LeaveStatus";
--   DROP TYPE "LeaveType";
--   DELETE FROM _prisma_migrations WHERE migration_name = '20261026110000_technician_leaves';

-- CreateEnum
CREATE TYPE "LeaveType" AS ENUM ('LEAVE', 'SICK', 'ABSENCE');

-- CreateEnum
CREATE TYPE "LeaveStatus" AS ENUM ('REQUESTED', 'APPROVED', 'REJECTED', 'CANCELLED');

-- CreateTable
CREATE TABLE "technician_leaves" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "startDate" DATE NOT NULL,
    "endDate" DATE NOT NULL,
    "type" "LeaveType" NOT NULL,
    "reason" TEXT,
    "status" "LeaveStatus" NOT NULL DEFAULT 'REQUESTED',
    "requestedById" TEXT NOT NULL,
    "decidedById" TEXT,
    "decidedAt" TIMESTAMPTZ(3),
    "decisionNote" TEXT,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "technician_leaves_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "technician_leaves_userId_startDate_idx" ON "technician_leaves"("userId", "startDate");

-- CreateIndex
CREATE INDEX "technician_leaves_status_startDate_idx" ON "technician_leaves"("status", "startDate");

-- AddForeignKey
ALTER TABLE "technician_leaves" ADD CONSTRAINT "technician_leaves_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "technician_leaves" ADD CONSTRAINT "technician_leaves_requestedById_fkey" FOREIGN KEY ("requestedById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "technician_leaves" ADD CONSTRAINT "technician_leaves_decidedById_fkey" FOREIGN KEY ("decidedById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- A leave covers at least one day.
ALTER TABLE "technician_leaves" ADD CONSTRAINT "technician_leaves_dates_check" CHECK ("endDate" >= "startDate");
