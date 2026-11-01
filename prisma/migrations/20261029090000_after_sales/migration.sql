-- After-sales (Aura phase B): complaints, customer satisfaction ratings, quality grades and
-- maintenance reminder calls. Additive only: a new enum, two new tables and nullable columns on
-- appointments. Existing rows are untouched.
--
-- Rollback (only if none of this data is needed any more):
--   DROP TABLE "maintenance_calls";
--   DROP TABLE "complaints";
--   DROP FUNCTION complaints_no_delete();
--   DROP TYPE "ComplaintStatus";
--   ALTER TABLE "appointments" DROP COLUMN "customerRating", DROP COLUMN "ratingNote", DROP COLUMN "ratedAt",
--     DROP COLUMN "ratedById", DROP COLUMN "qualityGrade", DROP COLUMN "gradedAt", DROP COLUMN "gradedById";

-- CreateEnum
CREATE TYPE "ComplaintStatus" AS ENUM ('NEW', 'ASSIGNED', 'RESOLVED', 'CLOSED');

-- AlterTable
ALTER TABLE "appointments" ADD COLUMN     "customerRating" SMALLINT,
ADD COLUMN     "gradedAt" TIMESTAMPTZ(3),
ADD COLUMN     "gradedById" TEXT,
ADD COLUMN     "qualityGrade" SMALLINT,
ADD COLUMN     "ratedAt" TIMESTAMPTZ(3),
ADD COLUMN     "ratedById" TEXT,
ADD COLUMN     "ratingNote" TEXT;

-- CreateTable
CREATE TABLE "complaints" (
    "id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "appointmentId" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "status" "ComplaintStatus" NOT NULL DEFAULT 'NEW',
    "warrantyUntil" DATE,
    "assignedToId" TEXT,
    "visitId" TEXT,
    "resolution" TEXT,
    "resolvedAt" TIMESTAMPTZ(3),
    "resolvedById" TEXT,
    "closedAt" TIMESTAMPTZ(3),
    "closedById" TEXT,
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,

    CONSTRAINT "complaints_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "maintenance_calls" (
    "id" TEXT NOT NULL,
    "appointmentId" TEXT NOT NULL,
    "milestone" SMALLINT NOT NULL,
    "note" TEXT,
    "calledById" TEXT NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "maintenance_calls_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "complaints_code_key" ON "complaints"("code");

-- CreateIndex
CREATE INDEX "complaints_status_createdAt_idx" ON "complaints"("status", "createdAt");

-- CreateIndex
CREATE INDEX "complaints_appointmentId_idx" ON "complaints"("appointmentId");

-- CreateIndex
CREATE INDEX "complaints_assignedToId_status_idx" ON "complaints"("assignedToId", "status");

-- CreateIndex
CREATE INDEX "complaints_visitId_idx" ON "complaints"("visitId");

-- CreateIndex
CREATE UNIQUE INDEX "maintenance_calls_appointmentId_milestone_key" ON "maintenance_calls"("appointmentId", "milestone");

-- AddForeignKey
ALTER TABLE "appointments" ADD CONSTRAINT "appointments_ratedById_fkey" FOREIGN KEY ("ratedById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "appointments" ADD CONSTRAINT "appointments_gradedById_fkey" FOREIGN KEY ("gradedById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "complaints" ADD CONSTRAINT "complaints_appointmentId_fkey" FOREIGN KEY ("appointmentId") REFERENCES "appointments"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "complaints" ADD CONSTRAINT "complaints_assignedToId_fkey" FOREIGN KEY ("assignedToId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "complaints" ADD CONSTRAINT "complaints_visitId_fkey" FOREIGN KEY ("visitId") REFERENCES "appointments"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "complaints" ADD CONSTRAINT "complaints_resolvedById_fkey" FOREIGN KEY ("resolvedById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "complaints" ADD CONSTRAINT "complaints_closedById_fkey" FOREIGN KEY ("closedById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "complaints" ADD CONSTRAINT "complaints_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "maintenance_calls" ADD CONSTRAINT "maintenance_calls_appointmentId_fkey" FOREIGN KEY ("appointmentId") REFERENCES "appointments"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "maintenance_calls" ADD CONSTRAINT "maintenance_calls_calledById_fkey" FOREIGN KEY ("calledById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- Ratings and grades are 1 to 5 stars, recorded together with who gave them and when.
ALTER TABLE "appointments" ADD CONSTRAINT "appointments_customerRating_check" CHECK ("customerRating" IS NULL OR "customerRating" BETWEEN 1 AND 5);
ALTER TABLE "appointments" ADD CONSTRAINT "appointments_rated_check" CHECK (("customerRating" IS NULL) = ("ratedAt" IS NULL) AND ("ratedAt" IS NULL) = ("ratedById" IS NULL));
ALTER TABLE "appointments" ADD CONSTRAINT "appointments_qualityGrade_check" CHECK ("qualityGrade" IS NULL OR "qualityGrade" BETWEEN 1 AND 5);
ALTER TABLE "appointments" ADD CONSTRAINT "appointments_graded_check" CHECK (("qualityGrade" IS NULL) = ("gradedAt" IS NULL) AND ("gradedAt" IS NULL) = ("gradedById" IS NULL));

ALTER TABLE "complaints" ADD CONSTRAINT "complaints_code_check" CHECK ("code" ~ '^C[0-9]{4}-[0-9]{3,}$');
ALTER TABLE "complaints" ADD CONSTRAINT "complaints_description_check" CHECK (length(btrim("description")) > 0);
ALTER TABLE "complaints" ADD CONSTRAINT "complaints_closed_check" CHECK (("status" = 'CLOSED') = ("closedAt" IS NOT NULL) AND ("closedAt" IS NULL) = ("closedById" IS NULL));
ALTER TABLE "complaints" ADD CONSTRAINT "complaints_resolved_check" CHECK (("resolvedAt" IS NULL) = ("resolvedById" IS NULL));
ALTER TABLE "complaints" ADD CONSTRAINT "complaints_version_check" CHECK ("version" >= 1);

ALTER TABLE "maintenance_calls" ADD CONSTRAINT "maintenance_calls_milestone_check" CHECK ("milestone" IN (6, 12));

-- Complaints are closed, never deleted.
CREATE FUNCTION complaints_no_delete() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'complaints cannot be deleted; close them instead';
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER complaints_no_delete BEFORE DELETE ON "complaints" FOR EACH ROW EXECUTE FUNCTION complaints_no_delete();
