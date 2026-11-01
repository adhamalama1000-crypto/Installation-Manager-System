import "server-only";
import type { AppointmentStatus, StatusKind } from "@prisma/client";
import type { Locale } from "@/i18n/config";
import { msg } from "@/i18n/translator";
import { statusName } from "@/lib/format";
import type { StatusDTO } from "@/lib/types";
import { fieldErrorsFromZod, statusInputSchema } from "@/lib/validation";
import { prisma } from "../db";
import { assertCan } from "../access";
import type { CurrentUser } from "../auth/session";
import { NotFoundError, ValidationError } from "../errors";
import { statusParam } from "../i18n-params";
import { diffValues, recordAudit } from "./audit";
import { isOverlapViolation, isUniqueViolation } from "./scheduling";

export function toStatusDTO(s: AppointmentStatus, locale: Locale): StatusDTO {
  return {
    id: s.id,
    name: s.name,
    nameAr: s.nameAr,
    label: statusName(s, locale),
    kind: s.kind,
    color: s.color,
    blocksSchedule: s.blocksSchedule,
    isDefault: s.isDefault,
    isActive: s.isActive,
    sortOrder: s.sortOrder,
  };
}

/** Statuses with `label` in the reader's language. */
export async function listStatuses(locale: Locale, options: { activeOnly?: boolean } = {}) {
  const rows = await prisma.appointmentStatus.findMany({
    where: options.activeOnly ? { isActive: true } : {},
    orderBy: [{ sortOrder: "asc" }, { name: "asc" }],
  });
  return rows.map((s) => toStatusDTO(s, locale));
}

function parse(raw: unknown) {
  const parsed = statusInputSchema.safeParse(raw);
  if (!parsed.success) throw new ValidationError(fieldErrorsFromZod(parsed.error));
  return parsed.data;
}

export async function createStatus(actor: CurrentUser, raw: unknown) {
  assertCan(actor, "settings.manage");
  const input = parse(raw);
  try {
    return await prisma.$transaction(async (tx) => {
      if (input.isDefault) await tx.appointmentStatus.updateMany({ data: { isDefault: false } });
      const s = await tx.appointmentStatus.create({
        data: { ...input, kind: input.kind as StatusKind, isDefault: input.isDefault ?? false, isActive: input.isActive ?? true },
      });
      await recordAudit(tx, {
        entityType: "STATUS",
        entityId: s.id,
        action: "STATUS_CREATED",
        summary: msg("audit.statusCreated", statusParam("name", s)),
        changes: { ...input },
        actorId: actor.id,
      });
      return toStatusDTO(s, actor.locale);
    });
  } catch (e) {
    if (isUniqueViolation(e, "name")) throw new ValidationError({ name: msg("statusErrors.nameExists") });
    throw e;
  }
}

export async function updateStatus(actor: CurrentUser, id: string, raw: unknown) {
  assertCan(actor, "settings.manage");
  const input = parse(raw);
  try {
    return await prisma.$transaction(async (tx) => {
      const before = await tx.appointmentStatus.findUnique({ where: { id } });
      if (!before) throw new NotFoundError("statusErrors.notFound");
      if (before.isDefault && input.isActive === false) {
        throw new ValidationError({ isActive: msg("statusErrors.defaultInactive") });
      }
      if (input.isDefault) await tx.appointmentStatus.updateMany({ where: { id: { not: id } }, data: { isDefault: false } });
      const after = await tx.appointmentStatus.update({
        where: { id },
        data: { ...input, kind: input.kind as StatusKind },
      });
      if (before.blocksSchedule !== after.blocksSchedule) {
        // Keep the denormalised flag (used by the overlap constraint) in sync. If this would create
        // double bookings the exclusion constraint rejects it and the change is rolled back.
        await tx.appointmentTechnician.updateMany({
          where: { appointment: { statusId: id } },
          data: { blocksSchedule: after.blocksSchedule },
        });
      }
      const changes = diffValues(before as unknown as Record<string, unknown>, after as unknown as Record<string, unknown>, [
        "name",
        "nameAr",
        "kind",
        "color",
        "blocksSchedule",
        "isDefault",
        "isActive",
        "sortOrder",
      ]);
      if (Object.keys(changes).length) {
        await recordAudit(tx, {
          entityType: "STATUS",
          entityId: id,
          action: "STATUS_UPDATED",
          summary: msg("audit.statusUpdated", statusParam("name", after)),
          changes,
          actorId: actor.id,
        });
      }
      return toStatusDTO(after, actor.locale);
    });
  } catch (e) {
    if (isUniqueViolation(e, "name")) throw new ValidationError({ name: msg("statusErrors.nameExists") });
    if (isOverlapViolation(e)) {
      throw new ValidationError({
        blocksSchedule: msg("statusErrors.overlap"),
      });
    }
    throw e;
  }
}
