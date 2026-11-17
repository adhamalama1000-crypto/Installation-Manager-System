import "server-only";
import { z } from "zod";
import type { RescheduleRequestStatus } from "@prisma/client";
import { msg } from "@/i18n/translator";
import { appointmentCode } from "@/lib/constants";
import { isValidDateString, TIME_RE, zonedToUtc } from "@/lib/time";
import { fieldErrorsFromZod } from "@/lib/validation";
import { prisma, type Tx } from "../db";
import { appointmentScope, assertCan, hasPermission } from "../access";
import type { CurrentUser } from "../auth/session";
import { ForbiddenError, NotFoundError, ValidationError } from "../errors";
import { activeHoldersOf } from "./access-control";
import { canManageAppointment } from "./appointments";
import { recordAudit } from "./audit";
import { notifyUsers } from "./notifications";

/**
 * A technician's request to move a visit assigned to them. The technician never changes the
 * booking: whoever booked it, or a scheduling manager (appointments.manageAll), reschedules it from
 * the booking and then marks the request done, or declines it with a note. Requests are kept (no
 * delete trigger) and each step is audited on the visit.
 */

export type RescheduleRequestDTO = {
  id: string;
  appointmentId: string;
  code: string;
  reason: string;
  proposedStart: string | null;
  status: RescheduleRequestStatus;
  requestedBy: string;
  createdAt: string;
  resolvedBy: string | null;
  resolvedAt: string | null;
  resolutionNote: string | null;
};

const text = (max: number) => z.preprocess((v) => (typeof v === "string" ? v.trim() : v), z.string().max(max, msg("validation.maxChars", { max })));

const requestSchema = z
  .object({
    reason: text(1000).pipe(z.string().min(1, msg("reschedule.reasonRequired"))),
    proposedDate: z.preprocess((v) => (v === "" ? null : v), z.string().refine(isValidDateString, msg("validation.date")).nullable()).optional(),
    proposedTime: z.preprocess((v) => (v === "" ? null : v), z.string().regex(TIME_RE, msg("validation.time")).nullable()).optional(),
  })
  .refine((d) => !d.proposedTime || !!d.proposedDate, { path: ["proposedDate"], message: msg("reschedule.dateForTime") });

const resolveSchema = z.object({
  status: z.enum(["DONE", "DECLINED"]),
  note: z.preprocess((v) => (typeof v === "string" ? v.trim() || null : (v ?? null)), z.string().max(1000).nullable()).optional(),
});

const include = {
  appointment: { select: { number: true } },
  requestedBy: { select: { name: true } },
  resolvedBy: { select: { name: true } },
} as const;

function toDTO(r: { id: string; appointmentId: string; reason: string; proposedStart: Date | null; status: RescheduleRequestStatus; createdAt: Date; resolvedAt: Date | null; resolutionNote: string | null; appointment: { number: number }; requestedBy: { name: string }; resolvedBy: { name: string } | null }): RescheduleRequestDTO {
  return {
    id: r.id,
    appointmentId: r.appointmentId,
    code: appointmentCode(r.appointment.number),
    reason: r.reason,
    proposedStart: r.proposedStart?.toISOString() ?? null,
    status: r.status,
    requestedBy: r.requestedBy.name,
    createdAt: r.createdAt.toISOString(),
    resolvedBy: r.resolvedBy?.name ?? null,
    resolvedAt: r.resolvedAt?.toISOString() ?? null,
    resolutionNote: r.resolutionNote,
  };
}

/** An assigned technician (visits.report) asks to move the visit. One open request per visit. */
export async function requestReschedule(user: CurrentUser, appointmentId: string, raw: unknown): Promise<RescheduleRequestDTO> {
  assertCan(user, "visits.report");
  const parsed = requestSchema.safeParse(raw);
  if (!parsed.success) throw new ValidationError(fieldErrorsFromZod(parsed.error));
  const { reason, proposedDate, proposedTime } = parsed.data;
  const tz = user.settings.timezone;
  return prisma.$transaction(async (tx) => {
    const appt = await lockAppointment(tx, user, appointmentId);
    if (!appt.technicians.some((t) => t.technicianId === user.id)) throw new ForbiddenError("reschedule.assignedOnly");
    if (!appt.status.blocksSchedule || appt.status.kind === "COMPLETED") throw new ValidationError({ _form: msg("reschedule.notOpen") }, msg("reschedule.notOpen"));
    const open = await tx.rescheduleRequest.findFirst({ where: { appointmentId: appt.id, status: "OPEN" }, select: { id: true } });
    if (open) throw new ValidationError({ _form: msg("reschedule.alreadyOpen") }, msg("reschedule.alreadyOpen"));
    const proposedStart = proposedDate ? zonedToUtc(proposedDate, proposedTime ?? "00:00", tz) : null;
    const row = await tx.rescheduleRequest.create({ data: { appointmentId: appt.id, requestedById: user.id, reason, proposedStart }, include });
    const code = appointmentCode(appt.number);
    await recordAudit(tx, {
      entityType: "APPOINTMENT",
      entityId: appt.id,
      appointmentId: appt.id,
      action: "RESCHEDULE_REQUESTED",
      summary: msg("audit.rescheduleRequested", { code }),
      changes: { reason, proposedStart: proposedStart?.toISOString() ?? null },
      actorId: user.id,
    });
    const managers = await activeHoldersOf(tx, "appointments.manageAll", user.settings);
    await notifyUsers(tx, [appt.createdById, ...managers], { appointmentId: appt.id, type: "RESCHEDULE_REQUESTED", message: msg("reschedule.notifyRequested", { name: user.name, code }) }, user.id);
    return toDTO(row);
  });
}

/** Whoever may edit the booking marks the request done (after moving it) or declines it. */
export async function resolveReschedule(user: CurrentUser, requestId: string, raw: unknown): Promise<RescheduleRequestDTO> {
  const parsed = resolveSchema.safeParse(raw);
  if (!parsed.success) throw new ValidationError(fieldErrorsFromZod(parsed.error));
  const { status, note } = parsed.data;
  if (status === "DECLINED" && !note) throw new ValidationError({ note: msg("reschedule.declineNote") });
  return prisma.$transaction(async (tx) => {
    if (typeof requestId !== "string" || requestId.length > 64) throw new NotFoundError();
    const locked = await tx.$queryRaw<{ id: string }[]>`SELECT id FROM reschedule_requests WHERE id = ${requestId} FOR UPDATE`;
    if (!locked.length) throw new NotFoundError();
    const req = await tx.rescheduleRequest.findUniqueOrThrow({ where: { id: requestId }, include: { ...include, appointment: { select: { number: true, createdById: true, id: true } } } });
    const visible = await tx.appointment.findFirst({ where: { AND: [{ id: req.appointmentId }, appointmentScope(user)] }, select: { id: true } });
    if (!visible) throw new NotFoundError();
    if (!canManageAppointment(user, req.appointment)) throw new ForbiddenError();
    if (req.status !== "OPEN") throw new ValidationError({ _form: msg("reschedule.alreadyAnswered") }, msg("reschedule.alreadyAnswered"));
    const row = await tx.rescheduleRequest.update({ where: { id: req.id }, data: { status, resolvedById: user.id, resolvedAt: new Date(), resolutionNote: note ?? null }, include });
    const code = appointmentCode(req.appointment.number);
    await recordAudit(tx, {
      entityType: "APPOINTMENT",
      entityId: req.appointmentId,
      appointmentId: req.appointmentId,
      action: "RESCHEDULE_RESOLVED",
      summary: msg("audit.rescheduleResolved", { code }),
      changes: { status, note: note ?? null },
      actorId: user.id,
    });
    await notifyUsers(tx, [req.requestedById], { appointmentId: req.appointmentId, type: "RESCHEDULE_RESOLVED", message: msg(status === "DONE" ? "reschedule.notifyDone" : "reschedule.notifyDeclined", { code, name: user.name }) }, user.id);
    return toDTO(row);
  });
}

/** Requests on one visit (its page), for readers who may see the visit. */
export async function visitRescheduleRequests(appointmentId: string): Promise<RescheduleRequestDTO[]> {
  const rows = await prisma.rescheduleRequest.findMany({ where: { appointmentId }, include, orderBy: { createdAt: "desc" } });
  return rows.map(toDTO);
}

/** Open requests the reader can act on (managers: all; others: on bookings they may edit). */
export async function openRescheduleRequests(user: CurrentUser): Promise<RescheduleRequestDTO[]> {
  if (!hasPermission(user, "appointments.manage")) return [];
  const rows = await prisma.rescheduleRequest.findMany({
    where: { status: "OPEN", appointment: { AND: [appointmentScope(user), hasPermission(user, "appointments.manageAll") || user.settings.salesCanEditOthersAppointments ? {} : { createdById: user.id }] } },
    include,
    orderBy: { createdAt: "asc" },
    take: 100,
  });
  return rows.map(toDTO);
}

async function lockAppointment(tx: Tx, user: CurrentUser, id: string) {
  if (typeof id !== "string" || id.length > 64) throw new NotFoundError();
  const rows = await tx.$queryRaw<{ id: string }[]>`SELECT id FROM appointments WHERE id = ${id} FOR UPDATE`;
  if (!rows.length) throw new NotFoundError();
  const appt = await tx.appointment.findFirst({
    where: { AND: [{ id }, appointmentScope(user)] },
    select: { id: true, number: true, createdById: true, status: { select: { blocksSchedule: true, kind: true } }, technicians: { select: { technicianId: true } } },
  });
  if (!appt) throw new NotFoundError();
  return appt;
}
