import "server-only";
import { Prisma, type LeaveType, type ProductCategory, type Specialty } from "@prisma/client";
import { appointmentCode, specialtyFits } from "@/lib/constants";
import { dateKey, dayRangeUtc } from "@/lib/time";
import type { Db, Tx } from "../db";
import type { ConflictDetail } from "../errors";

/**
 * Serialises all booking transactions that touch the same technician. Locks are taken in a
 * stable (sorted) order to avoid deadlocks and are released automatically at commit/rollback.
 * Together with the exclusion constraint on appointment_technicians this guarantees that two
 * simultaneous requests can never double-book a technician.
 */
export async function lockTechnicians(tx: Tx, technicianIds: string[]): Promise<void> {
  for (const id of [...new Set(technicianIds)].sort()) {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`technician:${id}`}, 0))`;
  }
}

export type ConflictQuery = {
  technicianIds: string[];
  startsAt: Date;
  endsAt: Date;
  excludeAppointmentId?: string | null;
  /** Minimum gap required between two appointments of the same technician (settings). */
  bufferMinutes?: number;
};

/**
 * Returns every schedule-blocking assignment of the given technicians that overlaps
 * [startsAt, endsAt). Uses real start AND end times (half-open intervals), so back-to-back
 * appointments are allowed and partial overlaps are detected. Cancelled appointments never
 * block because their assignments carry blocksSchedule = false.
 */
export async function findTechnicianConflicts(db: Db, q: ConflictQuery): Promise<ConflictDetail[]> {
  if (q.technicianIds.length === 0) return [];
  const buffer = (q.bufferMinutes ?? 0) * 60 * 1000;
  const rows = await db.appointmentTechnician.findMany({
    where: {
      technicianId: { in: q.technicianIds },
      blocksSchedule: true,
      startsAt: { lt: new Date(q.endsAt.getTime() + buffer) },
      endsAt: { gt: new Date(q.startsAt.getTime() - buffer) },
      ...(q.excludeAppointmentId ? { appointmentId: { not: q.excludeAppointmentId } } : {}),
    },
    include: {
      technician: { select: { id: true, name: true } },
      appointment: { select: { id: true, number: true, customer: { select: { name: true } } } },
    },
    orderBy: [{ startsAt: "asc" }],
  });
  return rows.map((r) => ({
    technicianId: r.technician.id,
    technicianName: r.technician.name,
    appointmentId: r.appointment.id,
    appointmentCode: appointmentCode(r.appointment.number),
    startsAt: r.startsAt.toISOString(),
    endsAt: r.endsAt.toISOString(),
    customerName: r.appointment.customer.name,
  }));
}

export type LeaveOnDay = { userId: string; name: string; type: LeaveType; startDate: string; endDate: string };

/** Approved leave of the given technicians that overlaps the company-local days of [startsAt, endsAt). */
export async function approvedLeaveDuring(db: Db, technicianIds: string[], startsAt: Date, endsAt: Date, tz: string): Promise<LeaveOnDay[]> {
  if (!technicianIds.length) return [];
  // Leave days are `@db.Date` columns, read and written as UTC midnight.
  const day = (key: string) => new Date(`${key}T00:00:00.000Z`);
  const first = dateKey(startsAt, tz);
  const last = dateKey(new Date(Math.max(startsAt.getTime(), endsAt.getTime() - 1)), tz);
  const rows = await db.technicianLeave.findMany({
    where: { userId: { in: technicianIds }, status: "APPROVED", startDate: { lte: day(last) }, endDate: { gte: day(first) } },
    select: { userId: true, type: true, startDate: true, endDate: true, user: { select: { name: true } } },
    orderBy: { startDate: "asc" },
  });
  return rows.map((r) => ({
    userId: r.userId,
    name: r.user.name,
    type: r.type,
    startDate: r.startDate.toISOString().slice(0, 10),
    endDate: r.endDate.toISOString().slice(0, 10),
  }));
}

export type TechnicianAvailability = {
  id: string;
  name: string;
  available: boolean;
  conflicts: ConflictDetail[];
  /** Approved leave covering the slot; the technician cannot be booked then. */
  leave: Omit<LeaveOnDay, "userId" | "name"> | null;
  /** Someone else is holding this slot for the technician right now. */
  held: { byName: string; expiresAt: string } | null;
  specialty: Specialty | null;
  /** False when the technician's specialty does not match the booking category. */
  fits: boolean;
  /** Schedule-blocking visits the technician already has that day. */
  dayLoad: number;
  /** One of the (at most two) best free technicians: right specialty, lightest day. */
  suggested: boolean;
};

/** Availability of every active technician for a proposed time slot (used by the booking form). */
export async function technicianAvailability(
  db: Db,
  q: Omit<ConflictQuery, "technicianIds"> & { timezone?: string; userId?: string; category?: ProductCategory | null; now?: Date },
): Promise<TechnicianAvailability[]> {
  const technicians = await db.user.findMany({
    where: { role: "TECHNICIAN", isActive: true },
    select: { id: true, name: true, specialty: true },
    orderBy: { name: "asc" },
  });
  const ids = technicians.map((t) => t.id);
  const day = q.timezone ? dayRangeUtc(dateKey(q.startsAt, q.timezone), dateKey(q.startsAt, q.timezone), q.timezone) : null;
  const [conflicts, leave, holds, load] = await Promise.all([
    findTechnicianConflicts(db, { ...q, technicianIds: ids }),
    q.timezone ? approvedLeaveDuring(db, ids, q.startsAt, q.endsAt, q.timezone) : Promise.resolve([]),
    db.slotHold.findMany({
      where: {
        technicianId: { in: ids },
        ...(q.userId ? { heldById: { not: q.userId } } : {}),
        expiresAt: { gt: q.now ?? new Date() },
        startsAt: { lt: q.endsAt },
        endsAt: { gt: q.startsAt },
      },
      select: { technicianId: true, expiresAt: true, heldBy: { select: { name: true } } },
    }),
    day
      ? db.appointmentTechnician.groupBy({
          by: ["technicianId"],
          where: {
            technicianId: { in: ids },
            blocksSchedule: true,
            startsAt: { gte: day.start, lt: day.end },
            ...(q.excludeAppointmentId ? { appointmentId: { not: q.excludeAppointmentId } } : {}),
          },
          _count: { _all: true },
        })
      : Promise.resolve([]),
  ]);
  const result = technicians.map((t): TechnicianAvailability => {
    const own = conflicts.filter((c) => c.technicianId === t.id);
    const away = leave.find((l) => l.userId === t.id);
    const hold = holds.find((h) => h.technicianId === t.id);
    return {
      id: t.id,
      name: t.name,
      available: own.length === 0 && !away && !hold,
      conflicts: own,
      leave: away ? { type: away.type, startDate: away.startDate, endDate: away.endDate } : null,
      held: hold ? { byName: hold.heldBy.name, expiresAt: hold.expiresAt.toISOString() } : null,
      specialty: t.specialty,
      fits: specialtyFits(t.specialty, q.category),
      dayLoad: load.find((l) => l.technicianId === t.id)?._count._all ?? 0,
      suggested: false,
    };
  });
  // Like the legacy "best technician" hint: free, right specialty, fewest visits that day.
  result
    .filter((t) => t.available && t.fits)
    .sort((a, b) => a.dayLoad - b.dayLoad || a.name.localeCompare(b.name))
    .slice(0, 2)
    .forEach((t) => (t.suggested = true));
  return result;
}

/** True when a Prisma/PostgreSQL error is the technician overlap exclusion constraint. */
export function isOverlapViolation(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const e = error as { code?: string; message?: string; meta?: Record<string, unknown> };
  const text = `${e.message ?? ""} ${JSON.stringify(e.meta ?? {})}`;
  return text.includes("appointment_technicians_no_overlap") || text.includes("23P01");
}

export function isUniqueViolation(error: unknown, field?: string): boolean {
  if (!(error instanceof Prisma.PrismaClientKnownRequestError) || error.code !== "P2002") return false;
  if (!field) return true;
  const target = error.meta?.target;
  return Array.isArray(target) ? target.includes(field) : String(target ?? "").includes(field);
}
