import "server-only";
import { createHash } from "node:crypto";
import type { AttachmentKind } from "@prisma/client";
import { msg } from "@/i18n/translator";
import { checklistItems } from "@/lib/delivery";
import type { AttachmentDTO, AttachmentRights } from "@/lib/types";
import { prisma, type Tx } from "../db";
import { appointmentScope } from "../access";
import type { CurrentUser } from "../auth/session";
import { ForbiddenError, NotFoundError, ValidationError } from "../errors";
import { detectImageType, discardFile, readStoredFile, saveFile } from "../storage";
import { recordAudit } from "./audit";
import { canManageAppointment, canReportVisit } from "./appointments";
import { canSeePrices } from "./payments";

/**
 * Photos, the customer's signature and transfer proofs on a visit (Aura: صور السيلز / صور الفني /
 * توقيع العميل / صورة التحويل / صورة العربون). Bytes are written to file storage first, then
 * recorded here; nothing is ever deleted, removals only mark the row.
 */

export const ATTACHMENT_KINDS: AttachmentKind[] = ["BEFORE_PHOTO", "AFTER_PHOTO", "SIGNATURE", "PAYMENT_PROOF", "DEPOSIT_PROOF"];
/** Kinds with one current file: a new upload replaces (marks removed) the previous one. */
const SINGLE: AttachmentKind[] = ["SIGNATURE", "PAYMENT_PROOF", "DEPOSIT_PROOF"];
/** Aura allowed 20 photos per order and kind. */
export const MAX_PHOTOS = 20;
const PROOFS: AttachmentKind[] = ["PAYMENT_PROOF", "DEPOSIT_PROOF"];

type Target = { id: string; createdById: string; technicians: { technician: { id: string } }[] };

async function visibleTarget(db: Tx | typeof prisma, user: CurrentUser, appointmentId: string): Promise<Target> {
  if (typeof appointmentId !== "string" || appointmentId.length > 64) throw new NotFoundError("errors.appointmentNotFound");
  const a = await db.appointment.findFirst({
    where: { AND: [{ id: appointmentId }, appointmentScope(user)] },
    select: { id: true, createdById: true, technicians: { select: { technician: { select: { id: true } } } } },
  });
  if (!a) throw new NotFoundError("errors.appointmentNotFound");
  return a;
}

export function attachmentRights(user: CurrentUser, a: Target): AttachmentRights {
  const manage = canManageAppointment(user, a);
  const report = canReportVisit(user, a);
  return { BEFORE_PHOTO: manage, AFTER_PHOTO: report, SIGNATURE: report, PAYMENT_PROOF: report, DEPOSIT_PROOF: manage };
}

/** Transfer proofs are money records: managers, finance and the visit's own technicians see them. */
function canView(user: CurrentUser, a: Target, kind: AttachmentKind): boolean {
  if (!PROOFS.includes(kind)) return true;
  return canSeePrices(user) || a.technicians.some((t) => t.technician.id === user.id);
}

function toDTO(user: CurrentUser, a: Target, row: { id: string; kind: AttachmentKind; uploadedBy: { id: string; name: string }; createdAt: Date }): AttachmentDTO {
  return {
    id: row.id,
    kind: row.kind,
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
      select: { id: true, kind: true, createdAt: true, uploadedBy: { select: { id: true, name: true } } },
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    }),
  ]);
  return { items: rows.filter((r) => canView(user, a, r.kind)).map((r) => toDTO(user, a, r)), rights: attachmentRights(user, a) };
}

export async function uploadAttachment(user: CurrentUser, appointmentId: string, kindRaw: string | null, bytes: Uint8Array | null): Promise<AttachmentDTO> {
  if (!ATTACHMENT_KINDS.includes(kindRaw as AttachmentKind)) throw new ValidationError({ kind: msg("attachments.errors.kind") });
  const kind = kindRaw as AttachmentKind;
  if (!bytes) throw new ValidationError({ file: msg("attachments.errors.tooLarge") }, msg("attachments.errors.tooLarge"));
  const type = detectImageType(bytes);
  if (!type || (kind === "SIGNATURE" && type !== "image/png")) {
    throw new ValidationError({ file: msg("attachments.errors.type") }, msg("attachments.errors.type"));
  }
  const a = await visibleTarget(prisma, user, appointmentId);
  if (!attachmentRights(user, a)[kind]) throw new ForbiddenError();

  const key = await saveFile(bytes, type);
  try {
    return await prisma.$transaction(async (tx) => {
      // One upload per visit at a time, so the photo limit and "replace the signature" are exact.
      await tx.$queryRaw`SELECT id FROM appointments WHERE id = ${appointmentId} FOR UPDATE`;
      const current = await tx.attachment.findMany({ where: { appointmentId, kind, deletedAt: null }, select: { id: true } });
      if (!SINGLE.includes(kind) && current.length >= MAX_PHOTOS) {
        const text = msg("attachments.errors.limit", { max: MAX_PHOTOS });
        throw new ValidationError({ file: text }, text);
      }
      const now = new Date();
      if (SINGLE.includes(kind) && current.length) {
        await tx.attachment.updateMany({ where: { id: { in: current.map((c) => c.id) } }, data: { deletedAt: now, deletedById: user.id } });
      }
      const row = await tx.attachment.create({
        data: { appointmentId, kind, contentType: type, byteSize: bytes.byteLength, sha256: createHash("sha256").update(bytes).digest("hex"), storageKey: key, uploadedById: user.id },
        select: { id: true, kind: true, createdAt: true, uploadedBy: { select: { id: true, name: true } } },
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

/** The bytes of a current file the reader may see (404 otherwise, so ids reveal nothing). */
export async function readAttachment(user: CurrentUser, id: string): Promise<{ bytes: Buffer; contentType: string }> {
  if (typeof id !== "string" || id.length > 64) throw new NotFoundError();
  const row = await prisma.attachment.findUnique({ where: { id }, select: { appointmentId: true, kind: true, contentType: true, storageKey: true, deletedAt: true } });
  if (!row || row.deletedAt) throw new NotFoundError();
  const a = await visibleTarget(prisma, user, row.appointmentId).catch(() => null);
  if (!a || !canView(user, a, row.kind)) throw new NotFoundError();
  return { bytes: await readStoredFile(row.storageKey), contentType: row.contentType };
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
