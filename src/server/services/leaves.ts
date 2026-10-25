import "server-only";
import { Prisma, type LeaveType } from "@prisma/client";
import type { LeaveClash, LeaveDTO } from "@/lib/types";
import { LEAVE_STATUS_LABELS, LEAVE_TYPE_LABELS, appointmentCode } from "@/lib/constants";
import { dayRangeLabel as leaveRangeLabel, dayRangeUtc, fmt, todayKey } from "@/lib/time";
import { fieldErrorsFromZod, leaveDecisionSchema, leaveInputSchema } from "@/lib/validation";
import { prisma, type Db, type Tx } from "../db";
import { assertCan, hasPermission } from "../access";
import type { CurrentUser } from "../auth/session";
import { ForbiddenError, NotFoundError, ValidationError } from "../errors";
import { recordAudit } from "./audit";
import { notifyUsers } from "./notifications";
import { approvedLeaveDuring, lockTechnicians } from "./scheduling";

/**
 * Technician leave (Aura: إجازة / مرضي / غياب). A technician asks for leave; an Admin approves or
 * rejects it, or records it directly. Approved leave blocks new bookings of that technician on
 * those company-local days (see assertTechniciansNotOnLeave) and is shown in the booking form.
 *
 * Leave and bookings of the same technician take the same advisory lock (lockTechnicians), so a
 * booking can never slip in while a leave covering that day is being approved, and the list of
 * bookings that need a new technician is exact at the moment of approval.
 */

const TX_OPTIONS = { timeout: 20_000, maxWait: 10_000 };

const leaveInclude = {
  user: { select: { id: true, name: true } },
  requestedBy: { select: { id: true, name: true } },
  decidedBy: { select: { id: true, name: true } },
} satisfies Prisma.TechnicianLeaveInclude;

type LeaveRow = Prisma.TechnicianLeaveGetPayload<{ include: typeof leaveInclude }>;

/** `@db.Date` columns are read and written as UTC midnight. */
const keyOf = (d: Date) => d.toISOString().slice(0, 10);
const dbDate = (key: string) => new Date(`${key}T00:00:00.000Z`);

function canCancel(user: CurrentUser, l: LeaveRow, today: string) {
  if (l.status !== "REQUESTED" && l.status !== "APPROVED") return false;
  if (hasPermission(user, "leaves.manage")) return true;
  return l.userId === user.id && hasPermission(user, "leaves.request") && (l.status === "REQUESTED" || keyOf(l.endDate) >= today);
}

function toDTO(user: CurrentUser, l: LeaveRow, today: string): LeaveDTO {
  const startDate = keyOf(l.startDate);
  const endDate = keyOf(l.endDate);
  return {
    id: l.id,
    user: l.user,
    startDate,
    endDate,
    days: Math.round((l.endDate.getTime() - l.startDate.getTime()) / 86_400_000) + 1,
    type: l.type,
    reason: l.reason,
    status: l.status,
    requestedBy: l.requestedBy,
    decidedBy: l.decidedBy,
    decidedAt: l.decidedAt?.toISOString() ?? null,
    decisionNote: l.decisionNote,
    createdAt: l.createdAt.toISOString(),
    canCancel: canCancel(user, l, today),
    canDecide: l.status === "REQUESTED" && hasPermission(user, "leaves.manage"),
  };
}

function assertLeaveAccess(user: CurrentUser) {
  if (!hasPermission(user, "leaves.manage") && !hasPermission(user, "leaves.request")) throw new ForbiddenError();
}

/** Admins see everyone's leave; technicians only their own. */
function leaveScope(user: CurrentUser): Prisma.TechnicianLeaveWhereInput {
  return hasPermission(user, "leaves.manage") ? {} : { userId: user.id };
}

export async function leaveOverview(user: CurrentUser, now: Date = new Date()) {
  assertLeaveAccess(user);
  const today = todayKey(user.settings.timezone, now);
  const scope = leaveScope(user);
  const [pending, upcoming, past] = await Promise.all([
    prisma.technicianLeave.findMany({
      where: { ...scope, status: "REQUESTED" },
      include: leaveInclude,
      orderBy: [{ startDate: "asc" }, { createdAt: "asc" }],
      take: 100,
    }),
    prisma.technicianLeave.findMany({
      where: { ...scope, status: "APPROVED", endDate: { gte: dbDate(today) } },
      include: leaveInclude,
      orderBy: [{ startDate: "asc" }, { user: { name: "asc" } }],
      take: 100,
    }),
    prisma.technicianLeave.findMany({
      where: { ...scope, OR: [{ status: { in: ["REJECTED", "CANCELLED"] } }, { status: "APPROVED", endDate: { lt: dbDate(today) } }] },
      include: leaveInclude,
      orderBy: [{ startDate: "desc" }, { createdAt: "desc" }],
      take: 30,
    }),
  ]);
  const map = (rows: LeaveRow[]) => rows.map((l) => toDTO(user, l, today));
  return { today, pending: map(pending), upcoming: map(upcoming), past: map(past) };
}

async function assertNoOverlappingLeave(tx: Tx, userId: string, startDate: string, endDate: string, excludeId: string | null) {
  const other = await tx.technicianLeave.findFirst({
    where: {
      userId,
      status: { in: ["REQUESTED", "APPROVED"] },
      startDate: { lte: dbDate(endDate) },
      endDate: { gte: dbDate(startDate) },
      ...(excludeId ? { id: { not: excludeId } } : {}),
    },
    select: { startDate: true, endDate: true, status: true },
  });
  if (other) {
    const msg = `This overlaps ${other.status === "APPROVED" ? "approved leave" : "a leave request"} on ${leaveRangeLabel(keyOf(other.startDate), keyOf(other.endDate))}.`;
    throw new ValidationError({ startDate: msg }, msg);
  }
}

/** Schedule-blocking bookings of the technician on any local day of the leave. */
async function bookingsDuringLeave(db: Db, userId: string, startDate: string, endDate: string, tz: string): Promise<LeaveClash[]> {
  const range = dayRangeUtc(startDate, endDate, tz);
  const rows = await db.appointmentTechnician.findMany({
    where: { technicianId: userId, blocksSchedule: true, startsAt: { lt: range.end }, endsAt: { gt: range.start } },
    select: { appointment: { select: { id: true, number: true, startsAt: true, createdById: true, customer: { select: { name: true } } } } },
    orderBy: { startsAt: "asc" },
    take: 200,
  });
  return rows.map(({ appointment: a }) => ({
    appointmentId: a.id,
    code: appointmentCode(a.number),
    customerName: a.customer.name,
    startsAt: a.startsAt.toISOString(),
    createdById: a.createdById,
  }));
}

/** Tells the Sales creator of every clashing booking that its technician is now on leave. */
async function notifyClashes(tx: Tx, clashes: LeaveClash[], technicianName: string, actorId: string, tz: string) {
  const data = clashes
    .filter((c) => c.createdById !== actorId)
    .map((c) => ({
      userId: c.createdById,
      appointmentId: c.appointmentId,
      type: "LEAVE_CLASH",
      message: `${technicianName} is on approved leave on ${fmt(c.startsAt, tz, "EEE d MMM")} - assign another technician to ${c.code} (${c.customerName})`.slice(0, 500),
    }));
  if (data.length) await tx.notification.createMany({ data });
}

async function activeAdminIds(tx: Tx) {
  return (await tx.user.findMany({ where: { role: "ADMIN", isActive: true }, select: { id: true } })).map((u) => u.id);
}

/**
 * A technician asks for leave (status "awaiting approval"), or an Admin records approved leave for
 * a technician. Returns the bookings that fall inside approved leave so they can be reassigned.
 */
export async function createLeave(user: CurrentUser, raw: unknown, now: Date = new Date()): Promise<{ leave: LeaveDTO; clashes: LeaveClash[] }> {
  assertLeaveAccess(user);
  const parsed = leaveInputSchema.safeParse(raw);
  if (!parsed.success) throw new ValidationError(fieldErrorsFromZod(parsed.error));
  const input = parsed.data;
  const manage = hasPermission(user, "leaves.manage");
  const tz = user.settings.timezone;
  const today = todayKey(tz, now);

  let targetId: string;
  if (manage) {
    if (!input.userId) throw new ValidationError({ userId: "Choose a technician." });
    targetId = input.userId;
  } else {
    if (input.userId && input.userId !== user.id) throw new ForbiddenError("You can only ask for leave for yourself.");
    if (input.startDate < today) throw new ValidationError({ startDate: "Leave cannot start in the past." });
    targetId = user.id;
  }

  return prisma.$transaction(async (tx) => {
    const target = await tx.user.findUnique({ where: { id: targetId }, select: { id: true, name: true, role: true, isActive: true } });
    if (!target || target.role !== "TECHNICIAN" || !target.isActive) throw new ValidationError({ userId: "Choose an active technician." });
    await lockTechnicians(tx, [target.id]);
    await assertNoOverlappingLeave(tx, target.id, input.startDate, input.endDate, null);
    const leave = await tx.technicianLeave.create({
      data: {
        userId: target.id,
        startDate: dbDate(input.startDate),
        endDate: dbDate(input.endDate),
        type: input.type as LeaveType,
        reason: input.reason,
        status: manage ? "APPROVED" : "REQUESTED",
        requestedById: user.id,
        decidedById: manage ? user.id : null,
        decidedAt: manage ? now : null,
      },
      include: leaveInclude,
    });
    const what = `${LEAVE_TYPE_LABELS[leave.type].toLowerCase()} on ${leaveRangeLabel(input.startDate, input.endDate)}`;
    await recordAudit(tx, {
      entityType: "LEAVE",
      entityId: leave.id,
      action: manage ? "LEAVE_ADDED" : "LEAVE_REQUESTED",
      summary: manage ? `Recorded ${what} for ${target.name}` : `${target.name} asked for ${what}`,
      changes: { technician: target.name, type: leave.type, startDate: input.startDate, endDate: input.endDate, reason: input.reason, status: leave.status },
      actorId: user.id,
    });
    let clashes: LeaveClash[] = [];
    if (manage) {
      await notifyUsers(tx, [target.id], { type: "LEAVE_APPROVED", message: `${user.name} recorded your ${what}` }, user.id);
      clashes = await bookingsDuringLeave(tx, target.id, input.startDate, input.endDate, tz);
      await notifyClashes(tx, clashes, target.name, user.id, tz);
    } else {
      await notifyUsers(tx, await activeAdminIds(tx), { type: "LEAVE_REQUESTED", message: `${target.name} asked for ${what}` }, user.id);
    }
    return { leave: toDTO(user, leave, today), clashes };
  }, TX_OPTIONS);
}

async function lockLeave(tx: Tx, id: string) {
  if (typeof id !== "string" || id.length > 64) throw new NotFoundError("Leave not found.");
  const rows = await tx.$queryRaw<{ id: string }[]>`SELECT id FROM technician_leaves WHERE id = ${id} FOR UPDATE`;
  if (!rows.length) throw new NotFoundError("Leave not found.");
  return tx.technicianLeave.findUniqueOrThrow({ where: { id }, include: leaveInclude });
}

/** An Admin approves or rejects a leave request. */
export async function decideLeave(user: CurrentUser, id: string, raw: unknown, now: Date = new Date()): Promise<{ leave: LeaveDTO; clashes: LeaveClash[] }> {
  assertCan(user, "leaves.manage");
  const parsed = leaveDecisionSchema.safeParse(raw);
  if (!parsed.success) throw new ValidationError(fieldErrorsFromZod(parsed.error));
  const { decision, note } = parsed.data;
  const tz = user.settings.timezone;
  const today = todayKey(tz, now);

  return prisma.$transaction(async (tx) => {
    const before = await lockLeave(tx, id);
    if (before.status !== "REQUESTED") {
      const msg = `This request is already ${LEAVE_STATUS_LABELS[before.status].toLowerCase()}.`;
      throw new ValidationError({ decision: msg }, msg);
    }
    const startDate = keyOf(before.startDate);
    const endDate = keyOf(before.endDate);
    if (decision === "APPROVED") {
      await lockTechnicians(tx, [before.userId]);
      await assertNoOverlappingLeave(tx, before.userId, startDate, endDate, before.id);
    }
    const leave = await tx.technicianLeave.update({
      where: { id },
      data: { status: decision, decidedById: user.id, decidedAt: now, decisionNote: note },
      include: leaveInclude,
    });
    const what = `${LEAVE_TYPE_LABELS[leave.type].toLowerCase()} on ${leaveRangeLabel(startDate, endDate)}`;
    const verb = decision === "APPROVED" ? "Approved" : "Rejected";
    await recordAudit(tx, {
      entityType: "LEAVE",
      entityId: leave.id,
      action: decision === "APPROVED" ? "LEAVE_APPROVED" : "LEAVE_REJECTED",
      summary: `${verb} ${what} for ${leave.user.name}${note ? `: ${note}` : ""}`,
      changes: { status: { from: before.status, to: decision }, ...(note ? { note } : {}) },
      actorId: user.id,
    });
    await notifyUsers(
      tx,
      [leave.userId, leave.requestedById],
      { type: decision === "APPROVED" ? "LEAVE_APPROVED" : "LEAVE_REJECTED", message: `${user.name} ${verb.toLowerCase()} your ${what}${note ? `: ${note}` : ""}` },
      user.id,
    );
    let clashes: LeaveClash[] = [];
    if (decision === "APPROVED") {
      clashes = await bookingsDuringLeave(tx, leave.userId, startDate, endDate, tz);
      await notifyClashes(tx, clashes, leave.user.name, user.id, tz);
    }
    return { leave: toDTO(user, leave, today), clashes };
  }, TX_OPTIONS);
}

/** Withdraws a request or ends approved leave; the technician becomes bookable again. */
export async function cancelLeave(user: CurrentUser, id: string, now: Date = new Date()): Promise<LeaveDTO> {
  assertLeaveAccess(user);
  const tz = user.settings.timezone;
  const today = todayKey(tz, now);
  return prisma.$transaction(async (tx) => {
    const before = await lockLeave(tx, id);
    const manage = hasPermission(user, "leaves.manage");
    if (!manage && before.userId !== user.id) throw new NotFoundError("Leave not found.");
    if (!canCancel(user, before, today)) {
      const msg = before.status === "APPROVED" ? "This leave has already ended." : `This leave is already ${LEAVE_STATUS_LABELS[before.status].toLowerCase()}.`;
      throw new ValidationError({ _form: msg }, msg);
    }
    const leave = await tx.technicianLeave.update({ where: { id }, data: { status: "CANCELLED" }, include: leaveInclude });
    const what = `${LEAVE_TYPE_LABELS[leave.type].toLowerCase()} on ${leaveRangeLabel(keyOf(leave.startDate), keyOf(leave.endDate))}`;
    await recordAudit(tx, {
      entityType: "LEAVE",
      entityId: leave.id,
      action: "LEAVE_CANCELLED",
      summary: `Cancelled ${what} for ${leave.user.name}`,
      changes: { status: { from: before.status, to: "CANCELLED" } },
      actorId: user.id,
    });
    const recipients = before.userId === user.id ? await activeAdminIds(tx) : [before.userId];
    await notifyUsers(tx, recipients, { type: "LEAVE_CANCELLED", message: `${user.name} cancelled ${before.userId === user.id ? "their" : "your"} ${what}` }, user.id);
    return toDTO(user, leave, today);
  }, TX_OPTIONS);
}

/** Refuses to book a technician on a day of approved leave. */
export async function assertTechniciansNotOnLeave(db: Db, technicianIds: string[], startsAt: Date, endsAt: Date, tz: string) {
  const leave = await approvedLeaveDuring(db, technicianIds, startsAt, endsAt, tz);
  if (!leave.length) return;
  const detail = leave.map((l) => `${l.name} is on ${LEAVE_TYPE_LABELS[l.type].toLowerCase()} (${leaveRangeLabel(l.startDate, l.endDate)})`);
  const names = [...new Set(leave.map((l) => l.name))].join(", ");
  throw new ValidationError({ technicianIds: `${detail.join("; ")}. Choose another technician or date.` }, `${names} ${leave.length === 1 ? "is" : "are"} on leave on this date.`);
}
