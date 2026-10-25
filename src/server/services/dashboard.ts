import "server-only";
import { Prisma } from "@prisma/client";
import { addDaysToKey, dayRangeUtc, startOfMonthKey, addMonthsToKey, todayKey } from "@/lib/time";
import { prisma } from "../db";
import { appointmentScope, appointmentScopeSql, assertCan, hasPermission } from "../access";
import type { CurrentUser } from "../auth/session";
import { calendarAppointments } from "./appointments";
import { appointmentListRows } from "./appointment-reads";

export type AttentionItem = {
  id: string;
  code: string;
  customerName: string;
  startsAt: string;
  reason: string;
};

export async function dashboardSummary(user: CurrentUser, now: Date = new Date()) {
  assertCan(user, "appointments.view");
  const tz = user.settings.timezone;
  const today = todayKey(tz, now);
  const todayRange = dayRangeUtc(today, today, tz);
  const monthStart = startOfMonthKey(today);
  const monthRange = dayRangeUtc(monthStart, addDaysToKey(addMonthsToKey(monthStart, 1), -1), tz);
  const weekAhead = dayRangeUtc(today, addDaysToKey(today, 7), tz).end;
  const endOfTomorrow = dayRangeUtc(today, addDaysToKey(today, 1), tz).end;
  const scope = appointmentScope(user);
  const scopeSql = appointmentScopeSql(user);
  const notCancelled: Prisma.AppointmentWhereInput = { status: { kind: { not: "CANCELLED" } } };
  const count = (where: Prisma.AppointmentWhereInput) => prisma.appointment.count({ where: { AND: [scope, where] } });
  const soonest = Prisma.sql`a."startsAt" ASC, a.number ASC`;
  const upcomingWeek = Prisma.sql`${scopeSql} AND s.kind <> 'CANCELLED' AND a."startsAt" >= ${now} AND a."startsAt" < ${weekAhead}`;

  // Everything is independent, so it all runs in a single round trip.
  const [todayCount, upcoming, scheduled, completed, postponed, cancelled, overdue, unassigned, noLocation, unconfirmed, revisit, onLeave, todays] = await Promise.all([
    count({ ...notCancelled, startsAt: { gte: todayRange.start, lt: todayRange.end } }),
    count({ ...notCancelled, startsAt: { gte: now }, status: { kind: { notIn: ["CANCELLED", "COMPLETED", "UNABLE_TO_COMPLETE", "NEEDS_REVISIT"] } } }),
    count({ status: { kind: "SCHEDULED" }, startsAt: { gte: todayRange.start } }),
    count({ status: { kind: "COMPLETED" }, startsAt: { gte: monthRange.start, lt: monthRange.end } }),
    count({ status: { kind: "POSTPONED" } }),
    count({ status: { kind: "CANCELLED" }, startsAt: { gte: monthRange.start, lt: monthRange.end } }),
    // "Needs attention": overdue status updates, unassigned or location-less upcoming jobs.
    appointmentListRows(
      user,
      Prisma.sql`${scopeSql} AND a."endsAt" < ${now} AND s.kind IN ('SCHEDULED', 'IN_PROGRESS')`,
      Prisma.sql`a."startsAt" DESC, a.number ASC`,
      20,
    ),
    appointmentListRows(
      user,
      Prisma.sql`${upcomingWeek} AND NOT EXISTS (SELECT 1 FROM appointment_technicians x WHERE x."appointmentId" = a.id)`,
      soonest,
      20,
    ),
    hasPermission(user, "location.view")
      ? appointmentListRows(user, Prisma.sql`${upcomingWeek} AND l."mapUrl" IS NULL AND l.latitude IS NULL`, soonest, 20)
      : Promise.resolve([]),
    appointmentListRows(
      user,
      Prisma.sql`${scopeSql} AND s.kind IN ('SCHEDULED', 'IN_PROGRESS') AND a."startsAt" >= ${now} AND a."startsAt" < ${endOfTomorrow}
        AND a."customerConfirmation" <> 'CONFIRMED'`,
      soonest,
      20,
    ),
    // Visits that need another visit (last 120 days) with no follow-up booked yet.
    appointmentListRows(
      user,
      Prisma.sql`${scopeSql} AND s.kind = 'NEEDS_REVISIT' AND a."startsAt" >= ${new Date(now.getTime() - 120 * 86_400_000)}
        AND NOT EXISTS (SELECT 1 FROM appointments f JOIN appointment_statuses fs ON fs.id = f."statusId"
                        WHERE f."followUpOfId" = a.id AND fs.kind <> 'CANCELLED')`,
      Prisma.sql`a."startsAt" DESC, a.number ASC`,
      20,
    ),
    // Bookings of the next 30 days whose technician has approved leave on that day (booked before
    // the leave was approved).
    appointmentListRows(
      user,
      Prisma.sql`${scopeSql} AND s.kind <> 'CANCELLED' AND a."startsAt" >= ${now} AND a."startsAt" < ${new Date(now.getTime() + 30 * 86_400_000)}
        AND EXISTS (SELECT 1 FROM appointment_technicians x
                    JOIN technician_leaves lv ON lv."userId" = x."technicianId" AND lv.status = 'APPROVED'
                    WHERE x."appointmentId" = a.id AND x."blocksSchedule"
                      AND lv."startDate" <= ((a."endsAt" - interval '1 millisecond') AT TIME ZONE ${tz})::date
                      AND lv."endDate" >= (a."startsAt" AT TIME ZONE ${tz})::date)`,
      soonest,
      20,
    ),
    calendarAppointments(user, { from: today, to: today }),
  ]);

  const attention: AttentionItem[] = [];
  const seen = new Set<string>();
  const push = (rows: typeof overdue, reason: string) => {
    for (const a of rows) {
      if (seen.has(a.id)) continue;
      seen.add(a.id);
      attention.push({ id: a.id, code: a.code, customerName: a.customerName, startsAt: a.startsAt, reason });
    }
  };
  push(overdue, "Past end time - status not updated");
  push(unassigned, "No technician assigned");
  push(onLeave, "Technician on approved leave - assign someone else");
  push(noLocation, "No map location saved");
  push(unconfirmed, "Customer has not confirmed - call before the visit");
  push(revisit, "Needs another visit - no follow-up booked");

  return {
    today,
    counts: { today: todayCount, upcoming, scheduled, completed, postponed, cancelled, attention: attention.length },
    attention: attention.slice(0, 15),
    todays,
  };
}
