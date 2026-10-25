import "server-only";
import type { Prisma } from "@prisma/client";
import { addDaysToKey, dayRangeUtc, startOfMonthKey, addMonthsToKey, todayKey } from "@/lib/time";
import { prisma } from "../db";
import { appointmentScope, assertCan, hasPermission } from "../access";
import type { CurrentUser } from "../auth/session";
import { calendarAppointments } from "./appointments";
import { appointmentCode } from "@/lib/constants";

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
  const scope = appointmentScope(user);
  const notCancelled: Prisma.AppointmentWhereInput = { status: { kind: { not: "CANCELLED" } } };
  const count = (where: Prisma.AppointmentWhereInput) => prisma.appointment.count({ where: { AND: [scope, where] } });

  const [todayCount, upcoming, scheduled, completed, postponed, cancelled] = await Promise.all([
    count({ ...notCancelled, startsAt: { gte: todayRange.start, lt: todayRange.end } }),
    count({ ...notCancelled, startsAt: { gte: now }, status: { kind: { notIn: ["CANCELLED", "COMPLETED", "UNABLE_TO_COMPLETE"] } } }),
    count({ status: { kind: "SCHEDULED" }, startsAt: { gte: todayRange.start } }),
    count({ status: { kind: "COMPLETED" }, startsAt: { gte: monthRange.start, lt: monthRange.end } }),
    count({ status: { kind: "POSTPONED" } }),
    count({ status: { kind: "CANCELLED" }, startsAt: { gte: monthRange.start, lt: monthRange.end } }),
  ]);

  // "Needs attention": overdue status updates, unassigned or location-less upcoming jobs.
  const attentionInclude = { customer: { select: { name: true } } } as const;
  const [overdue, unassigned, noLocation] = await Promise.all([
    prisma.appointment.findMany({
      where: { AND: [scope, { endsAt: { lt: now }, status: { kind: { in: ["SCHEDULED", "IN_PROGRESS"] } } }] },
      include: attentionInclude,
      orderBy: { startsAt: "desc" },
      take: 20,
    }),
    prisma.appointment.findMany({
      where: { AND: [scope, notCancelled, { startsAt: { gte: now, lt: weekAhead }, technicians: { none: {} } }] },
      include: attentionInclude,
      orderBy: { startsAt: "asc" },
      take: 20,
    }),
    hasPermission(user, "location.view")
      ? prisma.appointment.findMany({
          where: {
            AND: [
              scope,
              notCancelled,
              { startsAt: { gte: now, lt: weekAhead }, location: { mapUrl: null, latitude: null } },
            ],
          },
          include: attentionInclude,
          orderBy: { startsAt: "asc" },
          take: 20,
        })
      : Promise.resolve([]),
  ]);
  const attention: AttentionItem[] = [];
  const seen = new Set<string>();
  const push = (rows: typeof overdue, reason: string) => {
    for (const a of rows) {
      if (seen.has(a.id)) continue;
      seen.add(a.id);
      attention.push({ id: a.id, code: appointmentCode(a.number), customerName: a.customer.name, startsAt: a.startsAt.toISOString(), reason });
    }
  };
  push(overdue, "Past end time - status not updated");
  push(unassigned, "No technician assigned");
  push(noLocation, "No map location saved");

  const todays = await calendarAppointments(user, { from: today, to: today });

  return {
    today,
    counts: { today: todayCount, upcoming, scheduled, completed, postponed, cancelled, attention: attention.length },
    attention: attention.slice(0, 15),
    todays,
  };
}
