-- Photos, signatures and transfer proofs attached to visits, and the delivery checklist.
-- Additive only: a new enum, a new table and one column with a default. Existing rows are untouched.
--
-- Rollback (only if no attachments are needed any more; the uploaded files stay in UPLOAD_DIR):
--   DROP TABLE "attachments";
--   DROP FUNCTION attachments_guard();
--   DROP TYPE "AttachmentKind";
--   ALTER TABLE "appointments" DROP COLUMN "deliveryChecklist";

CREATE TYPE "AttachmentKind" AS ENUM ('BEFORE_PHOTO', 'AFTER_PHOTO', 'SIGNATURE', 'PAYMENT_PROOF', 'DEPOSIT_PROOF');

ALTER TABLE "appointments" ADD COLUMN "deliveryChecklist" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];

CREATE TABLE "attachments" (
    "id" TEXT NOT NULL,
    "appointmentId" TEXT NOT NULL,
    "kind" "AttachmentKind" NOT NULL,
    "contentType" TEXT NOT NULL,
    "byteSize" INTEGER NOT NULL,
    "sha256" TEXT NOT NULL,
    "storageKey" TEXT NOT NULL,
    "uploadedById" TEXT NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "deletedAt" TIMESTAMPTZ(3),
    "deletedById" TEXT,

    CONSTRAINT "attachments_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "attachments_contentType_check" CHECK ("contentType" IN ('image/jpeg', 'image/png', 'image/webp')),
    CONSTRAINT "attachments_byteSize_check" CHECK ("byteSize" > 0),
    CONSTRAINT "attachments_deleted_check" CHECK (("deletedAt" IS NULL) = ("deletedById" IS NULL))
);

CREATE UNIQUE INDEX "attachments_storageKey_key" ON "attachments"("storageKey");
CREATE INDEX "attachments_appointmentId_kind_createdAt_idx" ON "attachments"("appointmentId", "kind", "createdAt");

ALTER TABLE "attachments" ADD CONSTRAINT "attachments_appointmentId_fkey" FOREIGN KEY ("appointmentId") REFERENCES "appointments"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "attachments" ADD CONSTRAINT "attachments_uploadedById_fkey" FOREIGN KEY ("uploadedById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "attachments" ADD CONSTRAINT "attachments_deletedById_fkey" FOREIGN KEY ("deletedById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Rows are never removed; only "deletedAt" may be set (once).
CREATE FUNCTION attachments_guard() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'attachments are append-only; set "deletedAt" instead';
  END IF;
  IF OLD."deletedAt" IS NOT NULL
     OR NEW."appointmentId" <> OLD."appointmentId" OR NEW."kind" <> OLD."kind" OR NEW."storageKey" <> OLD."storageKey"
     OR NEW."sha256" <> OLD."sha256" OR NEW."uploadedById" <> OLD."uploadedById" OR NEW."createdAt" <> OLD."createdAt" THEN
    RAISE EXCEPTION 'attachments are append-only; only "deletedAt" may be set';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER attachments_guard BEFORE UPDATE OR DELETE ON "attachments" FOR EACH ROW EXECUTE FUNCTION attachments_guard();
