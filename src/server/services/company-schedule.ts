import "server-only";
import type { VisitType } from "@prisma/client";
import { appointmentCode, VISIT_TYPES } from "@/lib/constants";
import { addDaysToKey, dateKey, dayRangeUtc, startOfMonthKey, startOfWeekKey, timeKey, weekdayOfKey } from "@/lib/time";
import { prisma } from "../db";
import { appointmentScope, assertCan, hasPermission } from "../access";
import type { CurrentUser } from "../auth/session";
import { approvedLeaveDuring } from "./scheduling";
import type { DayHours } from "./work-hours";

/**
 * The company schedule: every technician's booked time, working hours, days off and leave, for a
 * day, a week or a month (schedule.global). It is read-only. Customer details (code, name, area)
 * appear only on visits the reader may already open (appointmentScope, or appointments.manageAll);
 * on anyone else's visits the reader sees the time, the job type and the status, never the customer.
 */

export const SCHEDULE_VIEWS = ["day", "week", "month"] as const;
export type ScheduleView = (typeof SCHEDULE_VIEWS)[number];

export type ScheduleJob = {
  id: string;
  startsAt: string;
  endsAt: string;
  time: string;
  visitType: VisitType | null;
  statusId: string;
  technicianIds: string[];
  /** Customer details are included only when the reader may see this visit. */
  visible: boolean;
  code: string | null;
  customerName: string | null;
  area: string | null;
};

export type ScheduleDay = {
  key: string;
  closed: boolean;
  hours: DayHours | null;
  leave: string | null;
  jobIds: string[];
  bookedMinutes: number;
  /** Working minutes that day (from the technician's hours, else the company day), 0 when off. */
  capacityMinutes: number;
};

export type CompanySchedule = {
  view: ScheduleView;
  date: string;
  from: string;
  to: string;
  days: string[];
  jobs: Record<string, ScheduleJob>;
  technicians: { id: string; name: string; days: Record<string, ScheduleDay> }[];
  /** Per day: technicians with nothing booked, partly booked, fully booked, and off (day off, leave or closed). */
  availability: Record<string, { free: number; partial: number; full: number; off: number }>;
};

export function scheduleRange(view: ScheduleView, date: string, weekStartsOn: number) {
  if (view === "day") return { from: date, to: date };
  if (view === "week") {
    const from = startOfWeekKey(date, weekStartsOn);
    return { from, to: addDaysToKey(from, 6) };
  }
  const from = startOfMonthKey(date);
  const next = addDaysToKey(from, 32);
  return { from, to: addDaysToKey(startOfMonthKey(next), -1) };
}

const minutesOf = (hhmm: string) => Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3, 5));

export async function companySchedule(
  user: CurrentUser,
  q: { view: ScheduleView; date: string; technicianId?: string | null; visitType?: string | null; statusId?: string | null },
): Promise<CompanySchedule> {
  assertCan(user, "schedule.global");
  // Filters from the address bar: unknown values are ignored rather than failing the page.
  const visitType = (VISIT_TYPES as readonly string[]).includes(q.visitType ?? "") ? (q.visitType as VisitType) : null;
  const statusId = q.statusId && q.statusId.length <= 64 ? q.statusId : null;
  const s = user.settings;
  const tz = s.timezone;
  const { from, to } = scheduleRange(q.view, q.date, s.weekStartsOn);
  const { start, end } = dayRangeUtc(from, to, tz);
  const days: string[] = [];
  for (let d = from; d <= to; d = addDaysToKey(d, 1)) days.push(d);

  const technicians = await prisma.user.findMany({
    where: { role: "TECHNICIAN", isActive: true, ...(q.technicianId && q.technicianId.length <= 64 ? { id: q.technicianId } : {}) },
    select: { id: true, name: true, workHours: { select: { weekday: true, isOff: true, startTime: true, endTime: true } } },
    orderBy: { name: "asc" },
  });
  const ids = technicians.map((t) => t.id);
  const [assignments, leave] = await Promise.all([
    prisma.appointmentTechnician.findMany({
      where: {
        technicianId: { in: ids },
        blocksSchedule: true,
        startsAt: { lt: end },
        endsAt: { gt: start },
        appointment: { ...(visitType ? { visitType } : {}), ...(statusId ? { statusId } : {}) },
      },
      select: {
        technicianId: true,
        appointment: {
          select: {
            id: true,
            number: true,
            startsAt: true,
            endsAt: true,
            visitType: true,
            statusId: true,
            customer: { select: { name: true } },
            location: { select: { area: true } },
            technicians: { select: { technicianId: true } },
          },
        },
      },
      orderBy: { startsAt: "asc" },
    }),
    approvedLeaveDuring(prisma, ids, start, end, tz),
  ]);

  const apptIds = [...new Set(assignments.map((a) => a.appointment.id))];
  const visible = hasPermission(user, "appointments.manageAll")
    ? new Set(apptIds)
    : new Set((await prisma.appointment.findMany({ where: { AND: [{ id: { in: apptIds } }, appointmentScope(user)] }, select: { id: true } })).map((a) => a.id));

  const jobs: Record<string, ScheduleJob> = {};
  for (const { appointment: a } of assignments) {
    if (jobs[a.id]) continue;
    const see = visible.has(a.id);
    jobs[a.id] = {
      id: a.id,
      startsAt: a.startsAt.toISOString(),
      endsAt: a.endsAt.toISOString(),
      time: `${timeKey(a.startsAt, tz)}–${timeKey(a.endsAt, tz)}`,
      visitType: a.visitType,
      statusId: a.statusId,
      technicianIds: a.technicians.map((t) => t.technicianId),
      visible: see,
      code: see ? appointmentCode(a.number) : null,
      customerName: see ? a.customer.name : null,
      area: see ? a.location.area : null,
    };
  }

  const companyCapacity = Math.max(0, (s.dayEndHour - s.dayStartHour) * 60);
  const availability: CompanySchedule["availability"] = Object.fromEntries(days.map((d) => [d, { free: 0, partial: 0, full: 0, off: 0 }]));
  const rows = technicians.map((t) => {
    const own = assignments.filter((a) => a.technicianId === t.id);
    const out: Record<string, ScheduleDay> = {};
    for (const key of days) {
      const weekday = weekdayOfKey(key);
      const h = t.workHours.find((x) => x.weekday === weekday);
      const hours: DayHours | null = h ? { weekday, isOff: h.isOff, startTime: h.startTime, endTime: h.endTime } : null;
      const away = leave.find((l) => l.userId === t.id && l.startDate <= key && l.endDate >= key);
      const closed = s.closedWeekdays.includes(weekday);
      const { start: dayStart, end: dayEnd } = dayRangeUtc(key, key, tz);
      const todays = own.filter((a) => a.appointment.startsAt < dayEnd && a.appointment.endsAt > dayStart);
      const booked = todays.reduce((m, a) => {
        const st = Math.max(a.appointment.startsAt.getTime(), dayStart.getTime());
        const en = Math.min(a.appointment.endsAt.getTime(), dayEnd.getTime());
        return m + Math.max(0, Math.round((en - st) / 60000));
      }, 0);
      // A company closed day counts as off unless the technician has set hours that day.
      const off = !!away || hours?.isOff === true || (closed && !hours?.startTime);
      const capacity = off ? 0 : hours?.startTime && hours.endTime ? minutesOf(hours.endTime) - minutesOf(hours.startTime) : companyCapacity;
      out[key] = { key, closed, hours, leave: away ? away.type : null, jobIds: todays.map((a) => a.appointment.id), bookedMinutes: booked, capacityMinutes: capacity };
      const slot = availability[key]!;
      if (off) slot.off++;
      else if (booked === 0) slot.free++;
      else if (capacity > 0 && booked >= capacity) slot.full++;
      else slot.partial++;
    }
    return { id: t.id, name: t.name, days: out };
  });

  return { view: q.view, date: q.date, from, to, days, jobs, technicians: rows, availability };
}

/** Today's key in the company timezone, for links. */
export function todayIn(user: CurrentUser) {
  return dateKey(new Date(), user.settings.timezone);
}
