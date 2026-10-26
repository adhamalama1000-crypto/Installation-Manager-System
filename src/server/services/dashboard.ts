import "server-only";
import { Prisma } from "@prisma/client";
import type { MessageKey } from "@/i18n/translate";
import { addDaysToKey, dayRangeUtc, startOfMonthKey, addMonthsToKey, todayKey } from "@/lib/time";
import { prisma } from "../db";
import { appointmentScopeSql, assertCan, hasPermission } from "../access";
import type { CurrentUser } from "../auth/session";
import { calendarAppointments } from "./appointments";
import { appointmentListRows } from "./appointment-reads";

export type AttentionItem = {
  id: string;
  code: string;
  customerName: string;
  startsAt: string;
  /** Message key of the reason (translated by the page). */
  reason: MessageKey;
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
  const scopeSql = appointmentScopeSql(user);
  const soonest = Prisma.sql`a."startsAt" ASC, a.number ASC`;
  const upcomingWeek = Prisma.sql`${scopeSql} AND s.kind <> 'CANCELLED' AND a."startsAt" >= ${now} AND a."startsAt" < ${weekAhead}`;

  // Everything is independent, so it all runs in one wave. The six counters are a single statement:
  // with six separate ones the page needed more statements than the connection pool (9 by default)
  // has connections, which costs an extra round trip to the database.
  const [[counts], overdue, unassigned, noLocation, unconfirmed, revisit, onLeave, todays] = await Promise.all([
    prisma.$queryRaw<{ today: number; upcoming: number; scheduled: number; completed: number; postponed: number; cancelled: number }[]>`
      SELECT
        count(*) FILTER (WHERE x.kind <> 'CANCELLED' AND x."startsAt" >= ${todayRange.start} AND x."startsAt" < ${todayRange.end})::int AS today,
        count(*) FILTER (WHERE x."startsAt" >= ${now} AND x.kind NOT IN ('CANCELLED', 'COMPLETED', 'UNABLE_TO_COMPLETE', 'NEEDS_REVISIT'))::int AS upcoming,
        count(*) FILTER (WHERE x.kind = 'SCHEDULED' AND x."startsAt" >= ${todayRange.start})::int AS scheduled,
        count(*) FILTER (WHERE x.kind = 'COMPLETED' AND x."startsAt" >= ${monthRange.start} AND x."startsAt" < ${monthRange.end})::int AS completed,
        count(*) FILTER (WHERE x.kind = 'POSTPONED')::int AS postponed,
        count(*) FILTER (WHERE x.kind = 'CANCELLED' AND x."startsAt" >= ${monthRange.start} AND x."startsAt" < ${monthRange.end})::int AS cancelled
      FROM (
        -- Every counter is about this month onwards, except postponed (any date); each part uses an index.
        SELECT a."startsAt", s.kind FROM appointments a JOIN appointment_statuses s ON s.id = a."statusId"
        WHERE ${scopeSql} AND a."startsAt" >= ${monthRange.start}
        UNION ALL
        SELECT a."startsAt", s.kind FROM appointments a JOIN appointment_statuses s ON s.id = a."statusId"
        WHERE ${scopeSql} AND s.kind = 'POSTPONED' AND a."startsAt" < ${monthRange.start}
      ) x`,
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
  const push = (rows: typeof overdue, reason: MessageKey) => {
    for (const a of rows) {
      if (seen.has(a.id)) continue;
      seen.add(a.id);
      attention.push({ id: a.id, code: a.code, customerName: a.customerName, startsAt: a.startsAt, reason });
    }
  };
  push(overdue, "dash.reason.overdue");
  push(unassigned, "dash.reason.unassigned");
  push(onLeave, "dash.reason.onLeave");
  push(noLocation, "dash.reason.noLocation");
  push(unconfirmed, "dash.reason.unconfirmed");
  push(revisit, "dash.reason.revisit");

  return {
    today,
    counts: { ...counts!, attention: attention.length },
    attention: attention.slice(0, 15),
    todays,
  };
}
