import "server-only";
import type { AppointmentStatus, StatusKind } from "@prisma/client";
import type { StatusDTO } from "@/lib/types";
import { fieldErrorsFromZod, statusInputSchema } from "@/lib/validation";
import { prisma } from "../db";
import { assertCan } from "../access";
import type { CurrentUser } from "../auth/session";
import { NotFoundError, ValidationError } from "../errors";
import { diffValues, recordAudit } from "./audit";
import { isOverlapViolation, isUniqueViolation } from "./scheduling";

export function toStatusDTO(s: AppointmentStatus): StatusDTO {
  return {
    id: s.id,
    name: s.name,
    kind: s.kind,
    color: s.color,
    blocksSchedule: s.blocksSchedule,
    isDefault: s.isDefault,
    isActive: s.isActive,
    sortOrder: s.sortOrder,
  };
}

export async function listStatuses(options: { activeOnly?: boolean } = {}) {
  const rows = await prisma.appointmentStatus.findMany({
    where: options.activeOnly ? { isActive: true } : {},
    orderBy: [{ sortOrder: "asc" }, { name: "asc" }],
  });
  return rows.map(toStatusDTO);
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
        summary: `Created appointment status "${s.name}"`,
        changes: { ...input },
        actorId: actor.id,
      });
      return toStatusDTO(s);
    });
  } catch (e) {
    if (isUniqueViolation(e, "name")) throw new ValidationError({ name: "A status with this name already exists." });
    throw e;
  }
}

export async function updateStatus(actor: CurrentUser, id: string, raw: unknown) {
  assertCan(actor, "settings.manage");
  const input = parse(raw);
  try {
    return await prisma.$transaction(async (tx) => {
      const before = await tx.appointmentStatus.findUnique({ where: { id } });
      if (!before) throw new NotFoundError("Status not found.");
      if (before.isDefault && input.isActive === false) {
        throw new ValidationError({ isActive: "Choose another default status before deactivating this one." });
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
          summary: `Updated appointment status "${after.name}"`,
          changes,
          actorId: actor.id,
        });
      }
      return toStatusDTO(after);
    });
  } catch (e) {
    if (isUniqueViolation(e, "name")) throw new ValidationError({ name: "A status with this name already exists." });
    if (isOverlapViolation(e)) {
      throw new ValidationError({
        blocksSchedule: "Some appointments in this status overlap for the same technician, so it cannot block schedules.",
      });
    }
    throw e;
  }
}
