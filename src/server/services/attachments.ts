import "server-only";
import { createHash } from "node:crypto";
import type { AttachmentKind, ProductCategory, VisitType } from "@prisma/client";
import { msg } from "@/i18n/translator";
import { checklistItems } from "@/lib/delivery";
import type { AttachmentDTO, AttachmentRights } from "@/lib/types";
import { prisma, type Tx } from "../db";
import { appointmentScope } from "../access";
import type { CurrentUser } from "../auth/session";
import { ForbiddenError, NotFoundError, ValidationError } from "../errors";
import { MAX_VIDEO_BYTES, detectImageType, detectVideoType, discardFile, readStoredFile, saveFile, storedFileSize } from "../storage";
import { recordAudit } from "./audit";
import { canManageAppointment, canReportVisit } from "./appointments";
import { requirementFor } from "./evidence";
import { canSeePrices } from "./payments";

/**
 * Photos, the customer's signature, transfer proofs and videos of the work on a visit (Aura: صور
 * السيلز / صور الفني / توقيع العميل / صورة التحويل / صورة العربون). Bytes are written to file storage
 * first, then recorded here; nothing is ever deleted, removals only mark the row.
 */

export const ATTACHMENT_KINDS: AttachmentKind[] = ["BEFORE_PHOTO", "AFTER_PHOTO", "SIGNATURE", "PAYMENT_PROOF", "DEPOSIT_PROOF", "VIDEO"];
/** Kinds with one current file: a new upload replaces (marks removed) the previous one. */
const SINGLE: AttachmentKind[] = ["SIGNATURE", "PAYMENT_PROOF", "DEPOSIT_PROOF"];
/** Aura allowed 20 photos per order and kind. */
export const MAX_PHOTOS = 20;
const PROOFS: AttachmentKind[] = ["PAYMENT_PROOF", "DEPOSIT_PROOF"];
/** Videos are large: a few per visit is enough to show the work. */
export const MAX_VIDEOS = 3;

type Target = { id: string; createdById: string; visitType: VisitType | null; productCategory: ProductCategory; technicians: { technician: { id: string } }[] };

async function visibleTarget(db: Tx | typeof prisma, user: CurrentUser, appointmentId: string): Promise<Target> {
  if (typeof appointmentId !== "string" || appointmentId.length > 64) throw new NotFoundError("errors.appointmentNotFound");
  const a = await db.appointment.findFirst({
    where: { AND: [{ id: appointmentId }, appointmentScope(user)] },
    select: { id: true, createdById: true, visitType: true, productCategory: true, technicians: { select: { technician: { select: { id: true } } } } },
  });
  if (!a) throw new NotFoundError("errors.appointmentNotFound");
  return a;
}

/**
 * What the reader may add. Before photos are the site photos Sales sends ahead of the visit; the
 * technician adds them too when the visit's evidence rule asks for before photos (taken on site
 * before the work starts).
 */
export function attachmentRights(user: CurrentUser, a: Target, techBeforePhotos = false): AttachmentRights {
  const manage = canManageAppointment(user, a);
  const report = canReportVisit(user, a);
  return { BEFORE_PHOTO: manage || (report && techBeforePhotos), AFTER_PHOTO: report, SIGNATURE: report, PAYMENT_PROOF: report, DEPOSIT_PROOF: manage, VIDEO: report };
}

async function rightsFor(db: Tx | typeof prisma, user: CurrentUser, a: Target): Promise<AttachmentRights> {
  const { req } = await requirementFor(db, a.visitType, a.productCategory);
  return attachmentRights(user, a, req.minBeforePhotos > 0);
}

/** Transfer proofs are money records: managers, finance and the visit's own technicians see them. */
function canView(user: CurrentUser, a: Target, kind: AttachmentKind): boolean {
  if (!PROOFS.includes(kind)) return true;
  return canSeePrices(user) || a.technicians.some((t) => t.technician.id === user.id);
}

function toDTO(user: CurrentUser, a: Target, row: { id: string; kind: AttachmentKind; contentType: string; uploadedBy: { id: string; name: string }; createdAt: Date }): AttachmentDTO {
  return {
    id: row.id,
    kind: row.kind,
    contentType: row.contentType,
    url: `/api/attachments/${row.id}`,
    uploadedBy: row.uploadedBy,
    createdAt: row.createdAt.toISOString(),
    canDelete: row.uploadedBy.id === user.id || canManageAppointment(user, a),
  };
}

/** Current files of a visit the reader may see, oldest first, and what they may add. */
export async function listAttachments(user: CurrentUser, appointmentId: string): Promise<{ items: AttachmentDTO[]; rights: AttachmentRights }> {
  const [a, rows] = await Promise.all([
    visibleTarget(prisma, user, appointmentId),
    prisma.attachment.findMany({
      where: { appointmentId, deletedAt: null },
      select: { id: true, kind: true, contentType: true, createdAt: true, uploadedBy: { select: { id: true, name: true } } },
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    }),
  ]);
  return { items: rows.filter((r) => canView(user, a, r.kind)).map((r) => toDTO(user, a, r)), rights: await rightsFor(prisma, user, a) };
}

export async function uploadAttachment(user: CurrentUser, appointmentId: string, kindRaw: string | null, bytes: Uint8Array | null): Promise<AttachmentDTO> {
  if (!ATTACHMENT_KINDS.includes(kindRaw as AttachmentKind)) throw new ValidationError({ kind: msg("attachments.errors.kind") });
  const kind = kindRaw as AttachmentKind;
  if (!bytes) {
    const text = kind === "VIDEO" ? msg("attachments.errors.videoTooLarge", { mb: Math.round(MAX_VIDEO_BYTES / 1024 / 1024) }) : msg("attachments.errors.tooLarge");
    throw new ValidationError({ file: text }, text);
  }
  // The type comes from the file's own bytes; videos only as VIDEO, images never as VIDEO.
  const type = kind === "VIDEO" ? detectVideoType(bytes) : detectImageType(bytes);
  if (!type || (kind === "SIGNATURE" && type !== "image/png")) {
    const text = msg(kind === "VIDEO" ? "attachments.errors.videoType" : "attachments.errors.type");
    throw new ValidationError({ file: text }, text);
  }
  const a = await visibleTarget(prisma, user, appointmentId);
  if (!(await rightsFor(prisma, user, a))[kind]) throw new ForbiddenError();

  const key = await saveFile(bytes, type);
  try {
    return await prisma.$transaction(async (tx) => {
      // One upload per visit at a time, so the photo limit and "replace the signature" are exact.
      await tx.$queryRaw`SELECT id FROM appointments WHERE id = ${appointmentId} FOR UPDATE`;
      const current = await tx.attachment.findMany({ where: { appointmentId, kind, deletedAt: null }, select: { id: true } });
      const max = kind === "VIDEO" ? MAX_VIDEOS : MAX_PHOTOS;
      if (!SINGLE.includes(kind) && current.length >= max) {
        const text = msg(kind === "VIDEO" ? "attachments.errors.videoLimit" : "attachments.errors.limit", { max });
        throw new ValidationError({ file: text }, text);
      }
      const now = new Date();
      if (SINGLE.includes(kind) && current.length) {
        await tx.attachment.updateMany({ where: { id: { in: current.map((c) => c.id) } }, data: { deletedAt: now, deletedById: user.id } });
      }
      const row = await tx.attachment.create({
        data: { appointmentId, kind, contentType: type, byteSize: bytes.byteLength, sha256: createHash("sha256").update(bytes).digest("hex"), storageKey: key, uploadedById: user.id },
        select: { id: true, kind: true, contentType: true, createdAt: true, uploadedBy: { select: { id: true, name: true } } },
      });
      await recordAudit(tx, {
        entityType: "APPOINTMENT",
        entityId: appointmentId,
        appointmentId,
        action: "ATTACHMENT_ADDED",
        summary: msg(current.length && SINGLE.includes(kind) ? "audit.attachmentReplaced" : "audit.attachmentAdded", { kind: `@attachments.kind.${kind}` }),
        changes: { attachment: row.id, kind, bytes: bytes.byteLength },
        actorId: user.id,
      });
      return toDTO(user, a, row);
    });
  } catch (e) {
    await discardFile(key).catch(() => undefined);
    throw e;
  }
}

/** Marks a file removed (the uploader, or whoever manages the booking). The file and the row are kept. */
export async function removeAttachment(user: CurrentUser, id: string): Promise<void> {
  if (typeof id !== "string" || id.length > 64) throw new NotFoundError();
  const row = await prisma.attachment.findUnique({ where: { id }, select: { id: true, appointmentId: true, kind: true, uploadedById: true, deletedAt: true } });
  if (!row || row.deletedAt) throw new NotFoundError();
  const a = await visibleTarget(prisma, user, row.appointmentId);
  if (!canView(user, a, row.kind)) throw new NotFoundError();
  if (row.uploadedById !== user.id && !canManageAppointment(user, a)) throw new ForbiddenError();
  await prisma.$transaction(async (tx) => {
    const done = await tx.attachment.updateMany({ where: { id, deletedAt: null }, data: { deletedAt: new Date(), deletedById: user.id } });
    if (!done.count) throw new NotFoundError();
    await recordAudit(tx, {
      entityType: "APPOINTMENT",
      entityId: row.appointmentId,
      appointmentId: row.appointmentId,
      action: "ATTACHMENT_REMOVED",
      summary: msg("audit.attachmentRemoved", { kind: `@attachments.kind.${row.kind}` }),
      changes: { attachment: id, kind: row.kind },
      actorId: user.id,
    });
  });
}

async function readableRow(user: CurrentUser, id: string) {
  if (typeof id !== "string" || id.length > 64) throw new NotFoundError();
  const row = await prisma.attachment.findUnique({ where: { id }, select: { appointmentId: true, kind: true, contentType: true, storageKey: true, deletedAt: true } });
  if (!row || row.deletedAt) throw new NotFoundError();
  const a = await visibleTarget(prisma, user, row.appointmentId).catch(() => null);
  if (!a || !canView(user, a, row.kind)) throw new NotFoundError();
  return row;
}

/** The bytes of a current file the reader may see (404 otherwise, so ids reveal nothing). */
export async function readAttachment(user: CurrentUser, id: string): Promise<{ bytes: Buffer; contentType: string }> {
  const row = await readableRow(user, id);
  return { bytes: await readStoredFile(row.storageKey), contentType: row.contentType };
}

/** Where a file the reader may see is stored and how big it is (videos are streamed in ranges). */
export async function locateAttachment(user: CurrentUser, id: string): Promise<{ storageKey: string; contentType: string; size: number }> {
  const row = await readableRow(user, id);
  return { storageKey: row.storageKey, contentType: row.contentType, size: await storedFileSize(row.storageKey) };
}

/** Saves the ticked delivery checklist items (the assigned technician or a manager). */
export async function setDeliveryChecklist(user: CurrentUser, appointmentId: string, raw: unknown): Promise<string[]> {
  const items = (raw as { items?: unknown })?.items;
  if (!Array.isArray(items) || items.some((x) => typeof x !== "string")) throw new ValidationError({ items: msg("validation.invalid") });
  const a = await visibleTarget(prisma, user, appointmentId);
  if (!canReportVisit(user, a)) throw new ForbiddenError();
  return prisma.$transaction(async (tx) => {
    const appt = await tx.appointment.findUniqueOrThrow({ where: { id: appointmentId }, select: { productCategory: true, deliveryChecklist: true } });
    const allowed = checklistItems(appt.productCategory);
    const next = allowed.filter((i) => (items as string[]).includes(i));
    if (next.length !== new Set(items as string[]).size) throw new ValidationError({ items: msg("validation.invalid") });
    if (JSON.stringify(next) === JSON.stringify(allowed.filter((i) => appt.deliveryChecklist.includes(i)))) return next;
    // Not a booking edit: the version is left alone so an open edit form does not go stale.
    await tx.appointment.update({ where: { id: appointmentId }, data: { deliveryChecklist: next } });
    await recordAudit(tx, {
      entityType: "APPOINTMENT",
      entityId: appointmentId,
      appointmentId,
      action: "DELIVERY_CHECKLIST",
      summary: msg("audit.checklist", { done: next.length, total: allowed.length }),
      changes: { deliveryChecklist: { from: appt.deliveryChecklist, to: next } },
      actorId: user.id,
    });
    return next;
  });
}
