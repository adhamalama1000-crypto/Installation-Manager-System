-- ERP upgrade, work evidence: what each kind of visit must show before it is done, and the review
-- of the submitted work. Additive, plus one relaxed check:
--   * evidence_rules and work_reviews: new tables (work_reviews is append-only).
--   * attachments_contentType_check is replaced by a wider one that also allows MP4, QuickTime
--     and WebM videos. Every existing row (JPEG, PNG or WebP) satisfies the new check; no row
--     changes. The attachments trigger (append-only) is unchanged.
--
-- Rollback (only if no video and no review is needed any more):
--   DROP TRIGGER work_reviews_append_only ON "work_reviews"; DROP FUNCTION work_reviews_append_only();
--   DROP TABLE "work_reviews", "evidence_rules"; DROP TYPE "WorkReviewEvent";
--   ALTER TABLE "attachments" DROP CONSTRAINT "attachments_contentType_check",
--     ADD CONSTRAINT "attachments_contentType_check" CHECK ("contentType" IN ('image/jpeg', 'image/png', 'image/webp'));
--     (fails while video rows exist)
--   DELETE FROM _prisma_migrations WHERE migration_name = '20261105130100_work_evidence';

ALTER TABLE "attachments" DROP CONSTRAINT "attachments_contentType_check";
ALTER TABLE "attachments" ADD CONSTRAINT "attachments_contentType_check" CHECK ("contentType" IN ('image/jpeg', 'image/png', 'image/webp', 'video/mp4', 'video/quicktime', 'video/webm'));
-- Videos only under the VIDEO kind, and the VIDEO kind only for videos.
ALTER TABLE "attachments" ADD CONSTRAINT "attachments_video_kind_check" CHECK (("kind" = 'VIDEO') = ("contentType" LIKE 'video/%'));

CREATE TYPE "WorkReviewEvent" AS ENUM ('SUBMITTED', 'APPROVED', 'REJECTED');

CREATE TABLE "evidence_rules" (
    "id" TEXT NOT NULL,
    "visitType" TEXT NOT NULL DEFAULT '',
    "productCategory" TEXT NOT NULL DEFAULT '',
    "minBeforePhotos" INTEGER NOT NULL DEFAULT 0,
    "minAfterPhotos" INTEGER NOT NULL DEFAULT 0,
    "requireVideo" BOOLEAN NOT NULL DEFAULT false,
    "requireSignature" BOOLEAN NOT NULL DEFAULT false,
    "requireCustomerConfirmation" BOOLEAN NOT NULL DEFAULT false,
    "requireReview" BOOLEAN NOT NULL DEFAULT false,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "updatedById" TEXT,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,
    CONSTRAINT "evidence_rules_pkey" PRIMARY KEY ("id")
);
-- '' = any visit type / any category.
CREATE UNIQUE INDEX "evidence_rules_visitType_productCategory_key" ON "evidence_rules"("visitType", "productCategory");
ALTER TABLE "evidence_rules" ADD CONSTRAINT "evidence_rules_updatedById_fkey" FOREIGN KEY ("updatedById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "evidence_rules" ADD CONSTRAINT "evidence_rules_values_check" CHECK (
  "visitType" IN ('', 'INSPECTION', 'INSTALLATION', 'COMPLETION', 'PROGRAMMING', 'MAINTENANCE')
  AND "productCategory" IN ('', 'SMART_LOCK', 'SMART_HOME', 'CCTV', 'INTERCOM', 'OTHER')
  AND "minBeforePhotos" BETWEEN 0 AND 20 AND "minAfterPhotos" BETWEEN 0 AND 20
);

CREATE TABLE "work_reviews" (
    "id" TEXT NOT NULL,
    "appointmentId" TEXT NOT NULL,
    "event" "WorkReviewEvent" NOT NULL,
    "note" TEXT,
    "customerConfirmed" BOOLEAN NOT NULL DEFAULT false,
    "customerName" TEXT,
    "actorId" TEXT NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "work_reviews_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "work_reviews_appointmentId_createdAt_idx" ON "work_reviews"("appointmentId", "createdAt");
CREATE INDEX "work_reviews_event_createdAt_idx" ON "work_reviews"("event", "createdAt");
ALTER TABLE "work_reviews" ADD CONSTRAINT "work_reviews_appointmentId_fkey" FOREIGN KEY ("appointmentId") REFERENCES "appointments"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "work_reviews" ADD CONSTRAINT "work_reviews_actorId_fkey" FOREIGN KEY ("actorId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
-- A rejection always says why.
ALTER TABLE "work_reviews" ADD CONSTRAINT "work_reviews_reason_check" CHECK ("event" <> 'REJECTED' OR ("note" IS NOT NULL AND length(trim("note")) > 0));
CREATE OR REPLACE FUNCTION work_reviews_append_only() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'work_reviews are append-only; record a new event instead';
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER work_reviews_append_only BEFORE UPDATE OR DELETE ON "work_reviews" FOR EACH ROW EXECUTE FUNCTION work_reviews_append_only();
