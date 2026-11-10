-- ERP upgrade, penalties and deductions: rules that propose violations, violations that a person
-- approves, rejects or cancels, the history of each, and the deduction entries finance reads.
-- Additive only: new enums and tables; nothing existing changes.
--
-- Guards (no deduction without approval, no rewriting history):
--   * violations: never deleted; who / when / what it was proposed as never change; a proposed
--     violation may be approved, rejected or cancelled; an approved one only cancelled; a rejected
--     or cancelled one never changes. A rejection or cancellation always gives the reason.
--   * violation_events and deduction_entries are append-only. A deduction entry exists only for an
--     approved deduction (and one reversal if it is cancelled), with the approved amount.
--
-- Rollback (only if no violation is needed any more):
--   DROP TABLE "deduction_entries", "violation_events", "violations", "penalty_rules";
--   DROP FUNCTION violations_guard(), penalty_append_only(), deduction_entries_guard();
--   DROP TYPE "DeductionEntryKind", "ViolationEventType", "ViolationStatus", "ViolationKind", "PenaltyAction", "PenaltyTrigger";
--   DELETE FROM _prisma_migrations WHERE migration_name = '20261105140000_penalties_deductions';

-- CreateEnum
CREATE TYPE "PenaltyTrigger" AS ENUM ('MANUAL', 'LATE_ARRIVAL', 'EARLY_LEAVE', 'MISSING_CLOCK_OUT', 'ABSENCE', 'ATTENDANCE_REJECTED', 'WORK_REJECTED');

-- CreateEnum
CREATE TYPE "PenaltyAction" AS ENUM ('WARNING', 'FIXED', 'PER_MINUTE');

-- CreateEnum
CREATE TYPE "ViolationKind" AS ENUM ('WARNING', 'DEDUCTION');

-- CreateEnum
CREATE TYPE "ViolationStatus" AS ENUM ('PROPOSED', 'APPROVED', 'REJECTED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "ViolationEventType" AS ENUM ('PROPOSED', 'APPROVED', 'REJECTED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "DeductionEntryKind" AS ENUM ('APPROVAL', 'REVERSAL');

-- CreateTable
CREATE TABLE "penalty_rules" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "nameAr" TEXT,
    "trigger" "PenaltyTrigger" NOT NULL,
    "action" "PenaltyAction" NOT NULL,
    "amount" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "graceMinutes" INTEGER NOT NULL DEFAULT 0,
    "maxAmount" DECIMAL(12,2),
    "warningsFirst" INTEGER NOT NULL DEFAULT 0,
    "description" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "updatedById" TEXT,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "penalty_rules_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "violations" (
    "id" TEXT NOT NULL,
    "number" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "ruleId" TEXT,
    "trigger" "PenaltyTrigger" NOT NULL,
    "sourceKey" TEXT,
    "occurredOn" DATE NOT NULL,
    "minutes" INTEGER,
    "kind" "ViolationKind" NOT NULL,
    "amount" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "proposedKind" "ViolationKind" NOT NULL,
    "proposedAmount" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "description" TEXT NOT NULL,
    "appointmentId" TEXT,
    "status" "ViolationStatus" NOT NULL DEFAULT 'PROPOSED',
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "decidedById" TEXT,
    "decidedAt" TIMESTAMPTZ(3),
    "decisionNote" TEXT,
    "cancelledById" TEXT,
    "cancelledAt" TIMESTAMPTZ(3),
    "cancelReason" TEXT,

    CONSTRAINT "violations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "violation_events" (
    "id" TEXT NOT NULL,
    "violationId" TEXT NOT NULL,
    "event" "ViolationEventType" NOT NULL,
    "kind" "ViolationKind" NOT NULL,
    "amount" DECIMAL(12,2) NOT NULL,
    "note" TEXT,
    "actorId" TEXT NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "violation_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "deduction_entries" (
    "id" TEXT NOT NULL,
    "violationId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "month" TEXT NOT NULL,
    "amount" DECIMAL(12,2) NOT NULL,
    "kind" "DeductionEntryKind" NOT NULL,
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "deduction_entries_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "violations_number_key" ON "violations"("number");

-- CreateIndex
CREATE UNIQUE INDEX "violations_sourceKey_key" ON "violations"("sourceKey");

-- CreateIndex
CREATE INDEX "violations_status_occurredOn_idx" ON "violations"("status", "occurredOn");

-- CreateIndex
CREATE INDEX "violations_userId_occurredOn_idx" ON "violations"("userId", "occurredOn");

-- CreateIndex
CREATE INDEX "violation_events_violationId_createdAt_idx" ON "violation_events"("violationId", "createdAt");

-- CreateIndex
CREATE INDEX "deduction_entries_month_userId_idx" ON "deduction_entries"("month", "userId");

-- CreateIndex
CREATE UNIQUE INDEX "deduction_entries_violationId_kind_key" ON "deduction_entries"("violationId", "kind");

-- AddForeignKey
ALTER TABLE "penalty_rules" ADD CONSTRAINT "penalty_rules_updatedById_fkey" FOREIGN KEY ("updatedById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "violations" ADD CONSTRAINT "violations_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "violations" ADD CONSTRAINT "violations_ruleId_fkey" FOREIGN KEY ("ruleId") REFERENCES "penalty_rules"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "violations" ADD CONSTRAINT "violations_appointmentId_fkey" FOREIGN KEY ("appointmentId") REFERENCES "appointments"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "violations" ADD CONSTRAINT "violations_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "violations" ADD CONSTRAINT "violations_decidedById_fkey" FOREIGN KEY ("decidedById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "violations" ADD CONSTRAINT "violations_cancelledById_fkey" FOREIGN KEY ("cancelledById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "violation_events" ADD CONSTRAINT "violation_events_violationId_fkey" FOREIGN KEY ("violationId") REFERENCES "violations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "violation_events" ADD CONSTRAINT "violation_events_actorId_fkey" FOREIGN KEY ("actorId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "deduction_entries" ADD CONSTRAINT "deduction_entries_violationId_fkey" FOREIGN KEY ("violationId") REFERENCES "violations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "deduction_entries" ADD CONSTRAINT "deduction_entries_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "deduction_entries" ADD CONSTRAINT "deduction_entries_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- Values that must hold whatever writes the row.
ALTER TABLE "penalty_rules" ADD CONSTRAINT "penalty_rules_values_check" CHECK (
  "amount" >= 0 AND ("action" = 'WARNING' OR "amount" > 0) AND ("action" <> 'WARNING' OR "amount" = 0)
  AND "graceMinutes" BETWEEN 0 AND 600 AND "warningsFirst" BETWEEN 0 AND 31
  AND ("maxAmount" IS NULL OR "maxAmount" > 0) AND length(trim("name")) > 0
);
ALTER TABLE "violations" ADD CONSTRAINT "violations_amount_check" CHECK (
  ("kind" = 'WARNING' AND "amount" = 0) OR ("kind" = 'DEDUCTION' AND "amount" > 0)
);
ALTER TABLE "violations" ADD CONSTRAINT "violations_proposed_check" CHECK (
  ("proposedKind" = 'WARNING' AND "proposedAmount" = 0) OR ("proposedKind" = 'DEDUCTION' AND "proposedAmount" > 0)
);
ALTER TABLE "violations" ADD CONSTRAINT "violations_status_check" CHECK (
  ("status" = 'PROPOSED' AND "decidedById" IS NULL AND "cancelledById" IS NULL)
  OR ("status" = 'APPROVED' AND "decidedById" IS NOT NULL AND "decidedAt" IS NOT NULL AND "cancelledById" IS NULL)
  OR ("status" = 'REJECTED' AND "decidedById" IS NOT NULL AND "decidedAt" IS NOT NULL AND "decisionNote" IS NOT NULL AND length(trim("decisionNote")) > 0)
  OR ("status" = 'CANCELLED' AND "cancelledById" IS NOT NULL AND "cancelledAt" IS NOT NULL AND "cancelReason" IS NOT NULL AND length(trim("cancelReason")) > 0)
);
ALTER TABLE "violations" ADD CONSTRAINT "violations_minutes_check" CHECK ("minutes" IS NULL OR "minutes" >= 0);
ALTER TABLE "deduction_entries" ADD CONSTRAINT "deduction_entries_amount_check" CHECK (
  ("kind" = 'APPROVAL' AND "amount" > 0) OR ("kind" = 'REVERSAL' AND "amount" < 0)
);
ALTER TABLE "deduction_entries" ADD CONSTRAINT "deduction_entries_month_check" CHECK ("month" ~ '^\d{4}-(0[1-9]|1[0-2])$');

CREATE OR REPLACE FUNCTION violations_guard() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'violations are never deleted; cancel the violation with a reason instead';
  END IF;
  IF NEW."id" <> OLD."id" OR NEW."number" <> OLD."number" OR NEW."userId" <> OLD."userId"
     OR NEW."ruleId" IS DISTINCT FROM OLD."ruleId" OR NEW."trigger" <> OLD."trigger"
     OR NEW."sourceKey" IS DISTINCT FROM OLD."sourceKey" OR NEW."occurredOn" <> OLD."occurredOn"
     OR NEW."minutes" IS DISTINCT FROM OLD."minutes" OR NEW."proposedKind" <> OLD."proposedKind"
     OR NEW."proposedAmount" <> OLD."proposedAmount" OR NEW."createdById" <> OLD."createdById"
     OR NEW."createdAt" <> OLD."createdAt" OR NEW."description" <> OLD."description"
     OR NEW."appointmentId" IS DISTINCT FROM OLD."appointmentId" THEN
    RAISE EXCEPTION 'a violation''s record cannot be changed';
  END IF;
  IF OLD."status" = 'PROPOSED' THEN
    RETURN NEW;
  END IF;
  IF OLD."status" = 'APPROVED' AND NEW."status" = 'CANCELLED'
     AND NEW."kind" = OLD."kind" AND NEW."amount" = OLD."amount"
     AND NEW."decidedById" IS NOT DISTINCT FROM OLD."decidedById" AND NEW."decidedAt" IS NOT DISTINCT FROM OLD."decidedAt"
     AND NEW."decisionNote" IS NOT DISTINCT FROM OLD."decisionNote" THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'a % violation cannot be changed to %', lower(OLD."status"::text), lower(NEW."status"::text);
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER violations_guard BEFORE UPDATE OR DELETE ON "violations" FOR EACH ROW EXECUTE FUNCTION violations_guard();

CREATE OR REPLACE FUNCTION penalty_append_only() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION '% is append-only', TG_TABLE_NAME;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER violation_events_append_only BEFORE UPDATE OR DELETE ON "violation_events" FOR EACH ROW EXECUTE FUNCTION penalty_append_only();
CREATE TRIGGER deduction_entries_append_only BEFORE UPDATE OR DELETE ON "deduction_entries" FOR EACH ROW EXECUTE FUNCTION penalty_append_only();

-- A deduction entry only for an approved deduction (APPROVAL) or a cancelled one that had been
-- approved (REVERSAL), for its employee and its approved amount.
CREATE OR REPLACE FUNCTION deduction_entries_guard() RETURNS trigger AS $$
DECLARE v RECORD;
BEGIN
  SELECT "userId", "kind", "amount", "status", "decidedById" INTO v FROM "violations" WHERE "id" = NEW."violationId";
  IF v IS NULL OR v."kind" <> 'DEDUCTION' OR v."userId" <> NEW."userId" THEN
    RAISE EXCEPTION 'a deduction entry needs a deduction of that employee';
  END IF;
  IF NEW."kind" = 'APPROVAL' AND (v."status" <> 'APPROVED' OR NEW."amount" <> v."amount") THEN
    RAISE EXCEPTION 'only an approved deduction reaches finance, with its approved amount';
  END IF;
  IF NEW."kind" = 'REVERSAL' AND (v."status" <> 'CANCELLED' OR v."decidedById" IS NULL OR NEW."amount" <> -v."amount") THEN
    RAISE EXCEPTION 'only a cancelled approved deduction is reversed, by its approved amount';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER deduction_entries_guard BEFORE INSERT ON "deduction_entries" FOR EACH ROW EXECUTE FUNCTION deduction_entries_guard();
