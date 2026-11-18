import "server-only";
import { z } from "zod";
import { msg } from "@/i18n/translator";
import { addDaysToKey, dateKey, TIME_RE, timeKey, weekdayOfKey } from "@/lib/time";
import { fieldErrorsFromZod } from "@/lib/validation";
import { prisma, type Db } from "../db";
import { assertCan } from "../access";
import type { CurrentUser } from "../auth/session";
import { NotFoundError, ValidationError } from "../errors";
import { recordAudit } from "./audit";

/**
 * Technicians' working hours, per weekday (0 = Sunday), in the company timezone. Each day is a day
 * off, set hours (start to end), or a working day without set hours. A technician with no rows has
 * no working-hours restriction (the behaviour before working hours existed). Booking outside a
 * technician's hours or on their day off is refused unless someone with appointments.override
 * books it with a reason (services/appointments.ts).
 */

export type DayHours = { weekday: number; isOff: boolean; startTime: string | null; endTime: string | null };
export type WorkHoursRow = { id: string; name: string; days: DayHours[]; configured: boolean; updatedAt: string | null; updatedBy: string | null };

const daySchema = z
  .object({
    weekday: z.number().int().min(0).max(6),
    isOff: z.boolean(),
    startTime: z.preprocess((v) => (v === "" ? null : v), z.string().regex(TIME_RE, msg("validation.time")).nullable()),
    endTime: z.preprocess((v) => (v === "" ? null : v), z.string().regex(TIME_RE, msg("validation.time")).nullable()),
  })
  .superRefine((d, ctx) => {
    if (d.isOff) return;
    if (!!d.startTime !== !!d.endTime) ctx.addIssue({ code: "custom", path: ["endTime"], message: msg("workHours.bothTimes") });
    else if (d.startTime && d.endTime && d.endTime <= d.startTime) ctx.addIssue({ code: "custom", path: ["endTime"], message: msg("workHours.endAfterStart") });
  });

const hoursSchema = z.object({
  days: z
    .array(daySchema)
    .length(7)
    .refine((days) => new Set(days.map((d) => d.weekday)).size === 7, msg("workHours.everyDay")),
  reason: z.preprocess((v) => (typeof v === "string" ? v.trim() || null : (v ?? null)), z.string().max(500).nullable()).optional(),
});

/** The working hours of every active technician (managers and the company schedule). */
export async function listWorkHours(db: Db = prisma): Promise<WorkHoursRow[]> {
  const technicians = await db.user.findMany({
    where: { role: "TECHNICIAN", isActive: true },
    select: { id: true, name: true, workHours: { select: { weekday: true, isOff: true, startTime: true, endTime: true, updatedAt: true, updatedBy: { select: { name: true } } }, orderBy: { weekday: "asc" } } },
    orderBy: { name: "asc" },
  });
  return technicians.map((t) => {
    const latest = t.workHours.reduce<(typeof t.workHours)[number] | null>((a, r) => (!a || r.updatedAt > a.updatedAt ? r : a), null);
    return {
      id: t.id,
      name: t.name,
      configured: t.workHours.length > 0,
      days: Array.from({ length: 7 }, (_, weekday) => {
        const r = t.workHours.find((x) => x.weekday === weekday);
        return r ? { weekday, isOff: r.isOff, startTime: r.startTime, endTime: r.endTime } : { weekday, isOff: false, startTime: null, endTime: null };
      }),
      updatedAt: latest ? latest.updatedAt.toISOString() : null,
      updatedBy: latest ? latest.updatedBy.name : null,
    };
  });
}

/** Sets a technician's seven days (schedule.manage). Rows are updated in place; the change is audited. */
export async function setWorkHours(user: CurrentUser, technicianId: string, raw: unknown) {
  assertCan(user, "schedule.manage");
  const parsed = hoursSchema.safeParse(raw);
  if (!parsed.success) throw new ValidationError(fieldErrorsFromZod(parsed.error));
  const { days, reason } = parsed.data;
  return prisma.$transaction(async (tx) => {
    const tech = await tx.user.findFirst({ where: { id: technicianId, role: "TECHNICIAN" }, select: { id: true, name: true, workHours: { select: { weekday: true, isOff: true, startTime: true, endTime: true } } } });
    if (!tech) throw new NotFoundError();
    const before = Object.fromEntries(tech.workHours.map((r) => [r.weekday, describe(r)]));
    const after: Record<number, string> = {};
    for (const d of days) {
      const data = { isOff: d.isOff, startTime: d.isOff ? null : d.startTime, endTime: d.isOff ? null : d.endTime, updatedById: user.id };
      after[d.weekday] = describe(data);
      await tx.technicianWorkHours.upsert({ where: { userId_weekday: { userId: tech.id, weekday: d.weekday } }, create: { userId: tech.id, weekday: d.weekday, ...data }, update: data });
    }
    const changed = Object.keys(after).filter((k) => before[Number(k)] !== after[Number(k)]);
    if (changed.length) {
      await recordAudit(tx, {
        entityType: "USER",
        entityId: tech.id,
        action: "WORK_HOURS_UPDATED",
        summary: msg("audit.workHoursUpdated", { name: tech.name }),
        changes: Object.fromEntries(changed.map((k) => [`weekday${k}`, { from: before[Number(k)] ?? null, to: after[Number(k)] }])),
        reason: reason ?? null,
        actorId: user.id,
      });
    }
    return { changed: changed.length };
  });
}

function describe(d: { isOff: boolean; startTime: string | null; endTime: string | null }) {
  return d.isOff ? "off" : d.startTime && d.endTime ? `${d.startTime}-${d.endTime}` : "any";
}

export type HoursViolation = { technicianId: string; rule: "outsideHours" | "dayOff"; message: string };

/**
 * Where a booking falls outside the technicians' working hours or on their day off. A booking that
 * runs past midnight is checked on every company-local day it touches.
 */
export async function workingHoursViolations(db: Db, technicianIds: string[], startsAt: Date, endsAt: Date, tz: string): Promise<HoursViolation[]> {
  if (!technicianIds.length) return [];
  const rows = await db.technicianWorkHours.findMany({ where: { userId: { in: technicianIds } }, select: { userId: true, weekday: true, isOff: true, startTime: true, endTime: true, user: { select: { name: true } } } });
  if (!rows.length) return [];
  const out: HoursViolation[] = [];
  const first = dateKey(startsAt, tz);
  const lastInstant = new Date(Math.max(startsAt.getTime(), endsAt.getTime() - 1));
  const last = dateKey(lastInstant, tz);
  for (const id of technicianIds) {
    const own = rows.filter((r) => r.userId === id);
    if (!own.length) continue;
    for (let day = first; day <= last; day = addDaysToKey(day, 1)) {
      const weekday = weekdayOfKey(day);
      const r = own.find((x) => x.weekday === weekday);
      if (!r) continue;
      const name = r.user.name;
      if (r.isOff) {
        out.push({ technicianId: id, rule: "dayOff", message: msg("appointmentErrors.technicianDayOff", { technician: name, day: `@enums.weekday.${weekday}` }) });
        break;
      }
      if (!r.startTime || !r.endTime) continue;
      // The part of the booking on this day, as HH:mm ("24:00" when it runs to midnight or beyond).
      const from = day === first ? timeKey(startsAt, tz) : "00:00";
      const to = day === last ? (endsAt.getTime() > startsAt.getTime() && dateKey(endsAt, tz) !== day ? "24:00" : timeKey(endsAt, tz)) : "24:00";
      if (from < r.startTime || to > r.endTime) {
        out.push({ technicianId: id, rule: "outsideHours", message: msg("appointmentErrors.outsideHours", { technician: name, day: `@enums.weekday.${weekday}`, start: r.startTime, end: r.endTime }) });
        break;
      }
    }
  }
  return out;
}

/** Each technician's hours for a weekday, for availability and the company schedule. */
export async function hoursOnWeekday(db: Db, technicianIds: string[], weekday: number): Promise<Map<string, DayHours>> {
  if (!technicianIds.length) return new Map();
  const rows = await db.technicianWorkHours.findMany({ where: { userId: { in: technicianIds }, weekday }, select: { userId: true, weekday: true, isOff: true, startTime: true, endTime: true } });
  return new Map(rows.map((r) => [r.userId, { weekday: r.weekday, isOff: r.isOff, startTime: r.startTime, endTime: r.endTime }]));
}
