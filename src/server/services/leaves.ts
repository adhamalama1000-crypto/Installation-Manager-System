import "server-only";
import { msg, ref, withNote, type Param } from "@/i18n/translate";
import { Prisma, type LeaveType } from "@prisma/client";
import type { LeaveClash, LeaveDTO } from "@/lib/types";
import { appointmentCode } from "@/lib/constants";
import { dateKey, dayRangeUtc, todayKey } from "@/lib/time";
import { fieldErrorsFromZod, leaveDecisionSchema, leaveInputSchema } from "@/lib/validation";
import { prisma, type Db, type Tx } from "../db";
import { assertCan, hasPermission } from "../access";
import type { CurrentUser } from "../auth/session";
import { ForbiddenError, NotFoundError, ValidationError } from "../errors";
import { recordAudit } from "./audit";
import { notifyUsers, storedNotification } from "./notifications";
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

/** "sick leave on Sat 14 Mar – Mon 16 Mar" in the reader's language. */
function leaveWhat(type: LeaveType, startDate: string, endDate: string): Param {
  return ref(`lv.what.${type}`, { range: { day: startDate, to: endDate } });
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
    const text = msg(other.status === "APPROVED" ? "e.leaveOverlapsApproved" : "e.leaveOverlapsRequest", { range: { day: keyOf(other.startDate), to: keyOf(other.endDate) } });
    throw new ValidationError({ startDate: text }, text);
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
      ...storedNotification(msg("n.leaveClash", { name: technicianName, day: { day: dateKey(new Date(c.startsAt), tz) }, code: c.code, customer: c.customerName })),
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
    if (!input.userId) throw new ValidationError({ userId: msg("e.chooseTechnicianLeave") });
    targetId = input.userId;
  } else {
    if (input.userId && input.userId !== user.id) throw new ForbiddenError(msg("e.ownLeaveOnly"));
    if (input.startDate < today) throw new ValidationError({ startDate: msg("e.leavePast") });
    targetId = user.id;
  }

  return prisma.$transaction(async (tx) => {
    const target = await tx.user.findUnique({ where: { id: targetId }, select: { id: true, name: true, role: true, isActive: true } });
    if (!target || target.role !== "TECHNICIAN" || !target.isActive) throw new ValidationError({ userId: msg("e.chooseActiveTechnician") });
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
    const what = leaveWhat(leave.type, input.startDate, input.endDate);
    await recordAudit(tx, {
      entityType: "LEAVE",
      entityId: leave.id,
      action: manage ? "LEAVE_ADDED" : "LEAVE_REQUESTED",
      summary: msg(manage ? "s.leaveRecorded" : "s.leaveAsked", { what, name: target.name }),
      changes: { technician: target.name, type: leave.type, startDate: input.startDate, endDate: input.endDate, reason: input.reason, status: leave.status },
      actorId: user.id,
    });
    let clashes: LeaveClash[] = [];
    if (manage) {
      await notifyUsers(tx, [target.id], { type: "LEAVE_APPROVED", message: msg("n.leaveRecorded", { user: user.name, what }) }, user.id);
      clashes = await bookingsDuringLeave(tx, target.id, input.startDate, input.endDate, tz);
      await notifyClashes(tx, clashes, target.name, user.id, tz);
    } else {
      await notifyUsers(tx, await activeAdminIds(tx), { type: "LEAVE_REQUESTED", message: msg("n.leaveAsked", { name: target.name, what }) }, user.id);
    }
    return { leave: toDTO(user, leave, today), clashes };
  }, TX_OPTIONS);
}

async function lockLeave(tx: Tx, id: string) {
  if (typeof id !== "string" || id.length > 64) throw new NotFoundError(msg("e.leaveNotFound"));
  const rows = await tx.$queryRaw<{ id: string }[]>`SELECT id FROM technician_leaves WHERE id = ${id} FOR UPDATE`;
  if (!rows.length) throw new NotFoundError(msg("e.leaveNotFound"));
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
      const text = msg("e.leaveAlready", { status: ref(`lv.status.${before.status}`) });
      throw new ValidationError({ decision: text }, text);
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
    const what = leaveWhat(leave.type, startDate, endDate);
    const approved = decision === "APPROVED";
    await recordAudit(tx, {
      entityType: "LEAVE",
      entityId: leave.id,
      action: decision === "APPROVED" ? "LEAVE_APPROVED" : "LEAVE_REJECTED",
      summary: withNote(msg(approved ? "s.leaveApproved" : "s.leaveRejected", { what, name: leave.user.name }), note),
      changes: { status: { from: before.status, to: decision }, ...(note ? { note } : {}) },
      actorId: user.id,
    });
    await notifyUsers(
      tx,
      [leave.userId, leave.requestedById],
      { type: decision === "APPROVED" ? "LEAVE_APPROVED" : "LEAVE_REJECTED", message: withNote(msg(approved ? "n.leaveApproved" : "n.leaveRejected", { user: user.name, what }), note) },
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
    if (!manage && before.userId !== user.id) throw new NotFoundError(msg("e.leaveNotFound"));
    if (!canCancel(user, before, today)) {
      const text = before.status === "APPROVED" ? msg("e.leaveEnded") : msg("e.leaveIsAlready", { status: ref(`lv.status.${before.status}`) });
      throw new ValidationError({ _form: text }, text);
    }
    const leave = await tx.technicianLeave.update({ where: { id }, data: { status: "CANCELLED" }, include: leaveInclude });
    const what = leaveWhat(leave.type, keyOf(leave.startDate), keyOf(leave.endDate));
    await recordAudit(tx, {
      entityType: "LEAVE",
      entityId: leave.id,
      action: "LEAVE_CANCELLED",
      summary: msg("s.leaveCancelled", { what, name: leave.user.name }),
      changes: { status: { from: before.status, to: "CANCELLED" } },
      actorId: user.id,
    });
    const recipients = before.userId === user.id ? await activeAdminIds(tx) : [before.userId];
    await notifyUsers(tx, recipients, { type: "LEAVE_CANCELLED", message: msg(before.userId === user.id ? "n.leaveCancelledTheirs" : "n.leaveCancelledYours", { user: user.name, what }) }, user.id);
    return toDTO(user, leave, today);
  }, TX_OPTIONS);
}

/** Refuses to book a technician on a day of approved leave. */
export async function assertTechniciansNotOnLeave(db: Db, technicianIds: string[], startsAt: Date, endsAt: Date, tz: string) {
  const leave = await approvedLeaveDuring(db, technicianIds, startsAt, endsAt, tz);
  if (!leave.length) return;
  const detail = leave.map((l) => ref("e.onLeaveOne", { name: l.name, type: ref(`lv.type.${l.type}`), range: { day: l.startDate, to: l.endDate } }));
  const names = [...new Set(leave.map((l) => l.name))];
  throw new ValidationError(
    { technicianIds: msg("e.onLeaveDetail", { detail: { lines: detail, sep: "; " } }) },
    msg("e.onLeave", { names: { join: names }, count: leave.length }),
  );
}
