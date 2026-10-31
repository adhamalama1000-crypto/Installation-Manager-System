import "server-only";
import { Prisma, type ComplaintStatus } from "@prisma/client";
import { msg } from "@/i18n/translator";
import type { Locale } from "@/i18n/config";
import { appointmentCode } from "@/lib/constants";
import { statusName } from "@/lib/format";
import { todayKey } from "@/lib/time";
import type { ComplaintDTO } from "@/lib/types";
import { complaintActionSchema, complaintOpenSchema, fieldErrorsFromZod } from "@/lib/validation";
import { prisma, type Tx } from "../db";
import { appointmentScope, assertCan, hasPermission } from "../access";
import type { CurrentUser } from "../auth/session";
import { ForbiddenError, NotFoundError, StaleRecordError, ValidationError } from "../errors";
import { recordAudit } from "./audit";
import { notifyUsers } from "./notifications";
import { canManageAppointment } from "./appointments";

/**
 * Customer complaints about a visit (Aura DB_Complaints). Sales (on bookings they manage) or an
 * Admin opens one; the head of installations (Admin) assigns it to a technician and links the
 * maintenance visit booked for it; the technician or the Admin writes the resolution; Sales or an
 * Admin closes it after calling the customer, or reopens it. Finishing the linked visit resolves it.
 * Complaints are never deleted (trigger).
 */

const TX_OPTIONS = { timeout: 20_000, maxWait: 10_000 };
const person = { select: { id: true, name: true } } as const;

const include = {
  appointment: {
    select: {
      id: true,
      number: true,
      startsAt: true,
      createdById: true,
      customerId: true,
      customer: { select: { name: true, phone: true } },
      location: { select: { area: true } },
      technicians: { select: { technician: person } },
    },
  },
  assignedTo: person,
  visit: { select: { id: true, number: true, startsAt: true, status: { select: { name: true, nameAr: true, color: true } }, technicians: { select: { technicianId: true } } } },
  createdBy: person,
  resolvedBy: person,
  closedBy: person,
} satisfies Prisma.ComplaintInclude;

type Row = Prisma.ComplaintGetPayload<{ include: typeof include }>;

/** Complaints the reader may see: technicians only those assigned to them and still open. */
export function complaintScope(user: CurrentUser): Prisma.ComplaintWhereInput {
  if (!hasPermission(user, "complaints.view")) return { id: { in: [] } };
  if (user.role === "TECHNICIAN") return { assignedToId: user.id, status: { not: "CLOSED" } };
  return { appointment: appointmentScope(user) };
}

function seesVisit(user: CurrentUser, techIds: string[]) {
  if (!hasPermission(user, "appointments.view")) return false;
  return user.role !== "TECHNICIAN" || techIds.includes(user.id);
}

function rights(user: CurrentUser, c: Row): ComplaintDTO["rights"] {
  const open = c.status !== "CLOSED";
  const head = hasPermission(user, "complaints.manage");
  const books = user.role !== "TECHNICIAN" && canManageAppointment(user, c.appointment);
  return {
    assign: open && head,
    linkVisit: open && head,
    resolve: open && (head || (c.assignedToId === user.id && hasPermission(user, "visits.report"))),
    close: open && books,
    reopen: !open && books,
  };
}

const keyOf = (d: Date) => d.toISOString().slice(0, 10);

function toDTO(user: CurrentUser, c: Row, locale: Locale): ComplaintDTO {
  const a = c.appointment;
  const techs = a.technicians.map((t) => t.technician);
  return {
    id: c.id,
    code: c.code,
    status: c.status,
    description: c.description,
    resolution: c.resolution,
    warrantyUntil: c.warrantyUntil ? keyOf(c.warrantyUntil) : null,
    appointment: {
      id: a.id,
      code: appointmentCode(a.number),
      startsAt: a.startsAt.toISOString(),
      customerName: a.customer.name,
      ...(hasPermission(user, "customers.contact") ? { customerPhone: a.customer.phone } : {}),
      area: hasPermission(user, "location.view") ? a.location.area : null,
      technicians: techs,
      canOpen: seesVisit(user, techs.map((t) => t.id)),
    },
    assignedTo: c.assignedTo,
    visit: c.visit
      ? {
          id: c.visit.id,
          code: appointmentCode(c.visit.number),
          startsAt: c.visit.startsAt.toISOString(),
          statusName: statusName(c.visit.status, locale),
          statusColor: c.visit.status.color,
          canOpen: seesVisit(user, c.visit.technicians.map((t) => t.technicianId)),
        }
      : null,
    createdBy: c.createdBy,
    createdAt: c.createdAt.toISOString(),
    resolvedBy: c.resolvedBy,
    resolvedAt: c.resolvedAt?.toISOString() ?? null,
    closedBy: c.closedBy,
    closedAt: c.closedAt?.toISOString() ?? null,
    version: c.version,
    rights: rights(user, c),
  };
}

export type ComplaintFilter = "open" | "all" | ComplaintStatus;
const FILTERS: ComplaintFilter[] = ["open", "all", "NEW", "ASSIGNED", "RESOLVED", "CLOSED"];
export const COMPLAINT_PAGE_SIZE = 25;

export async function listComplaints(user: CurrentUser, opts: { status?: string; q?: string; page?: number }) {
  assertCan(user, "complaints.view");
  const filter: ComplaintFilter = FILTERS.includes(opts.status as ComplaintFilter) ? (opts.status as ComplaintFilter) : "open";
  const q = (opts.q ?? "").trim().slice(0, 100);
  const where: Prisma.ComplaintWhereInput = {
    AND: [
      complaintScope(user),
      filter === "open" ? { status: { not: "CLOSED" } } : filter === "all" ? {} : { status: filter },
      q
        ? {
            OR: [
              { code: { contains: q, mode: "insensitive" } },
              { description: { contains: q, mode: "insensitive" } },
              { appointment: { customer: { name: { contains: q, mode: "insensitive" } } } },
            ],
          }
        : {},
    ],
  };
  const page = Math.max(1, Math.floor(opts.page ?? 1));
  const [rows, total] = await Promise.all([
    prisma.complaint.findMany({ where, include, orderBy: [{ createdAt: "desc" }, { id: "desc" }], skip: (page - 1) * COMPLAINT_PAGE_SIZE, take: COMPLAINT_PAGE_SIZE }),
    prisma.complaint.count({ where }),
  ]);
  return { items: rows.map((r) => toDTO(user, r, user.locale)), total, page, pageCount: Math.max(1, Math.ceil(total / COMPLAINT_PAGE_SIZE)), filter, q };
}

export async function getComplaint(user: CurrentUser, id: string): Promise<ComplaintDTO> {
  assertCan(user, "complaints.view");
  if (typeof id !== "string" || id.length > 64) throw new NotFoundError("errors.complaintNotFound");
  const row = await prisma.complaint.findFirst({ where: { AND: [{ id }, complaintScope(user)] }, include });
  if (!row) throw new NotFoundError("errors.complaintNotFound");
  return toDTO(user, row, user.locale);
}

/** Complaints about a visit, or for which it is the maintenance visit, that the reader may see. */
export async function complaintsForAppointment(user: CurrentUser, appointmentId: string): Promise<ComplaintDTO[]> {
  if (!hasPermission(user, "complaints.view")) return [];
  const rows = await prisma.complaint.findMany({
    where: { AND: [complaintScope(user), { OR: [{ appointmentId }, { visitId: appointmentId }] }] },
    include,
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
  });
  return rows.map((r) => toDTO(user, r, user.locale));
}

/** Whether the reader may open a complaint on this visit (Sales on bookings they manage, Admins). */
export function canOpenComplaint(user: CurrentUser, appt: { createdById: string }): boolean {
  return hasPermission(user, "complaints.view") && user.role !== "TECHNICIAN" && canManageAppointment(user, appt);
}

/** Visits the complaint can be linked to: later bookings of the same customer. */
export async function visitOptions(user: CurrentUser, c: ComplaintDTO) {
  if (!c.rights.linkVisit) return [];
  const base = await prisma.appointment.findUniqueOrThrow({ where: { id: c.appointment.id }, select: { customerId: true, startsAt: true } });
  const rows = await prisma.appointment.findMany({
    where: { customerId: base.customerId, id: { not: c.appointment.id }, startsAt: { gte: base.startsAt }, status: { kind: { not: "CANCELLED" } } },
    select: { id: true, number: true, startsAt: true, status: { select: { name: true, nameAr: true } } },
    orderBy: { startsAt: "asc" },
    take: 30,
  });
  return rows.map((r) => ({ id: r.id, code: appointmentCode(r.number), startsAt: r.startsAt.toISOString(), statusName: statusName(r.status, user.locale) }));
}

async function admins(tx: Tx) {
  return (await tx.user.findMany({ where: { role: "ADMIN", isActive: true }, select: { id: true } })).map((u) => u.id);
}

/** Aura's complaint number: C + yymm + "-" + sequence in that month (C2610-001). */
async function nextCode(tx: Tx, today: string) {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext('complaints.code'))`;
  const prefix = `C${today.slice(2, 4)}${today.slice(5, 7)}-`;
  const codes = await tx.complaint.findMany({ where: { code: { startsWith: prefix } }, select: { code: true } });
  const last = codes.reduce((m, c) => Math.max(m, Number(c.code.slice(prefix.length)) || 0), 0);
  return `${prefix}${String(last + 1).padStart(3, "0")}`;
}

export async function openComplaint(user: CurrentUser, appointmentId: string, raw: unknown): Promise<ComplaintDTO> {
  assertCan(user, "complaints.view");
  const parsed = complaintOpenSchema.safeParse(raw);
  if (!parsed.success) throw new ValidationError(fieldErrorsFromZod(parsed.error));
  if (typeof appointmentId !== "string" || appointmentId.length > 64) throw new NotFoundError("errors.appointmentNotFound");
  const appt = await prisma.appointment.findFirst({
    where: { AND: [{ id: appointmentId }, appointmentScope(user)] },
    select: { id: true, number: true, createdById: true, customer: { select: { name: true } } },
  });
  if (!appt) throw new NotFoundError("errors.appointmentNotFound");
  if (!canOpenComplaint(user, appt)) throw new ForbiddenError();
  const description = parsed.data.description;

  const id = await prisma.$transaction(async (tx) => {
    const code = await nextCode(tx, todayKey(user.settings.timezone));
    const warranty = await tx.stockItem.aggregate({ where: { appointmentId, status: "INSTALLED" }, _max: { warrantyUntil: true } });
    const c = await tx.complaint.create({
      data: { code, appointmentId, description, warrantyUntil: warranty._max.warrantyUntil, createdById: user.id },
      select: { id: true },
    });
    await recordAudit(tx, {
      entityType: "COMPLAINT",
      entityId: c.id,
      appointmentId,
      action: "COMPLAINT_OPENED",
      summary: msg("audit.complaintOpened", { code, appointment: appointmentCode(appt.number) }),
      changes: { code, description },
      actorId: user.id,
    });
    await notifyUsers(
      tx,
      await admins(tx),
      { appointmentId, type: "COMPLAINT", message: msg("notify.complaintNew", { code, customer: appt.customer.name, text: description.slice(0, 80) }) },
      user.id,
    );
    return c.id;
  }, TX_OPTIONS);
  return getComplaint(user, id);
}

export async function updateComplaint(user: CurrentUser, id: string, raw: unknown): Promise<ComplaintDTO> {
  assertCan(user, "complaints.view");
  const parsed = complaintActionSchema.safeParse(raw);
  if (!parsed.success) throw new ValidationError(fieldErrorsFromZod(parsed.error));
  const input = parsed.data;
  if (typeof id !== "string" || id.length > 64) throw new NotFoundError("errors.complaintNotFound");

  await prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM complaints WHERE id = ${id} FOR UPDATE`;
    const c = await tx.complaint.findFirst({ where: { AND: [{ id }, complaintScope(user)] }, include });
    if (!c) throw new NotFoundError("errors.complaintNotFound");
    if (c.version !== input.version) throw new StaleRecordError();
    const may = rights(user, c);
    const now = new Date();
    const audit = (action: string, summary: string, changes: Record<string, unknown>) =>
      recordAudit(tx, { entityType: "COMPLAINT", entityId: c.id, appointmentId: c.appointmentId, action, summary, changes, actorId: user.id });
    const save = (data: Prisma.ComplaintUncheckedUpdateInput) => tx.complaint.update({ where: { id }, data: { ...data, version: { increment: 1 } } });

    switch (input.action) {
      case "assign": {
        if (!may.assign) throw new ForbiddenError();
        if (input.technicianId === c.assignedToId) return;
        let tech: { id: string; name: string } | null = null;
        if (input.technicianId) {
          tech = await tx.user.findFirst({ where: { id: input.technicianId, role: "TECHNICIAN", isActive: true }, select: { id: true, name: true } });
          if (!tech) throw new ValidationError({ technicianId: msg("errors.complaintTechnician") }, msg("errors.complaintTechnician"));
        }
        // As in Aura: assigning (again) puts the complaint back in the technician's hands.
        await save({ assignedToId: tech?.id ?? null, status: tech ? "ASSIGNED" : "NEW" });
        await audit(
          tech ? "COMPLAINT_ASSIGNED" : "COMPLAINT_UNASSIGNED",
          tech ? msg("audit.complaintAssigned", { code: c.code, name: tech.name }) : msg("audit.complaintUnassigned", { code: c.code }),
          { assignedTo: { from: c.assignedTo?.name ?? null, to: tech?.name ?? null }, status: { from: c.status, to: tech ? "ASSIGNED" : "NEW" } },
        );
        if (tech) {
          await notifyUsers(
            tx,
            [tech.id],
            { appointmentId: c.appointmentId, type: "COMPLAINT", message: msg("notify.complaintAssigned", { code: c.code, customer: c.appointment.customer.name, text: c.description.slice(0, 80) }) },
            user.id,
          );
        }
        return;
      }
      case "linkVisit": {
        if (!may.linkVisit) throw new ForbiddenError();
        if (input.visitId === c.visitId) return;
        let visit: { id: string; number: number; visitReport: string | null; status: { kind: string } } | null = null;
        if (input.visitId) {
          visit = await tx.appointment.findFirst({
            where: { id: input.visitId, customerId: c.appointment.customerId, NOT: { id: c.appointmentId }, status: { kind: { not: "CANCELLED" } } },
            select: { id: true, number: true, visitReport: true, status: { select: { kind: true } } },
          });
          if (!visit) throw new ValidationError({ visitId: msg("errors.complaintVisit") }, msg("errors.complaintVisit"));
        }
        await save({ visitId: visit?.id ?? null });
        await audit(
          visit ? "COMPLAINT_VISIT_LINKED" : "COMPLAINT_VISIT_UNLINKED",
          visit ? msg("audit.complaintVisitLinked", { code: c.code, visit: appointmentCode(visit.number) }) : msg("audit.complaintVisitUnlinked", { code: c.code }),
          { visit: { from: c.visit ? appointmentCode(c.visit.number) : null, to: visit ? appointmentCode(visit.number) : null } },
        );
        // A visit that is already finished resolves the complaint straight away.
        if (visit?.status.kind === "COMPLETED") await resolveComplaintsForVisit(tx, { id: visit.id, visitReport: visit.visitReport }, user.id);
        return;
      }
      case "resolve": {
        if (!may.resolve) throw new ForbiddenError();
        await save({ resolution: input.resolution, status: "RESOLVED", resolvedAt: now, resolvedById: user.id });
        await audit("COMPLAINT_RESOLVED", msg("audit.complaintResolved", { code: c.code }), {
          resolution: { from: c.resolution, to: input.resolution },
          status: { from: c.status, to: "RESOLVED" },
        });
        await notifyUsers(
          tx,
          [c.createdById],
          { appointmentId: c.appointmentId, type: "COMPLAINT", message: msg("notify.complaintResolved", { code: c.code, customer: c.appointment.customer.name, name: user.name }) },
          user.id,
        );
        return;
      }
      case "close": {
        if (!may.close) throw new ForbiddenError();
        await save({ status: "CLOSED", closedAt: now, closedById: user.id });
        await audit("COMPLAINT_CLOSED", msg("audit.complaintClosed", { code: c.code }), { status: { from: c.status, to: "CLOSED" } });
        return;
      }
      case "reopen": {
        if (!may.reopen) throw new ForbiddenError();
        const status: ComplaintStatus = c.assignedToId ? "ASSIGNED" : "NEW";
        await save({ status, closedAt: null, closedById: null });
        await audit("COMPLAINT_REOPENED", msg("audit.complaintReopened", { code: c.code }), { status: { from: c.status, to: status } });
        if (c.assignedToId) {
          await notifyUsers(
            tx,
            [c.assignedToId],
            { appointmentId: c.appointmentId, type: "COMPLAINT", message: msg("notify.complaintReopened", { code: c.code, customer: c.appointment.customer.name }) },
            user.id,
          );
        }
        return;
      }
    }
  }, TX_OPTIONS);
  return getComplaint(user, id);
}

/**
 * Called when a visit is marked completed: complaints waiting on it as their maintenance visit
 * are resolved, with the visit report as the resolution unless one was written (Aura
 * resolveComplaints_).
 */
export async function resolveComplaintsForVisit(tx: Tx, visit: { id: string; visitReport: string | null }, actorId: string) {
  const open = await tx.complaint.findMany({
    where: { visitId: visit.id, status: { in: ["NEW", "ASSIGNED"] } },
    select: { id: true, code: true, appointmentId: true, createdById: true, resolution: true, status: true },
  });
  const now = new Date();
  for (const c of open) {
    const resolution = c.resolution || visit.visitReport;
    await tx.complaint.update({
      where: { id: c.id },
      data: { status: "RESOLVED", resolution, resolvedAt: now, resolvedById: actorId, version: { increment: 1 } },
    });
    await recordAudit(tx, {
      entityType: "COMPLAINT",
      entityId: c.id,
      appointmentId: c.appointmentId,
      action: "COMPLAINT_RESOLVED",
      summary: msg("audit.complaintAutoResolved", { code: c.code }),
      changes: { status: { from: c.status, to: "RESOLVED" }, resolution: { from: c.resolution, to: resolution } },
      actorId,
    });
    await notifyUsers(tx, [c.createdById], { appointmentId: c.appointmentId, type: "COMPLAINT", message: msg("notify.complaintAutoResolved", { code: c.code }) }, actorId);
  }
}
