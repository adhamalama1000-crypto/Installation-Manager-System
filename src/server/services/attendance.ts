import "server-only";
import { createHash } from "node:crypto";
import { Prisma, type AttendanceSite, type CheckIn } from "@prisma/client";
import { z } from "zod";
import { msg } from "@/i18n/translator";
import { appointmentCode } from "@/lib/constants";
import { minutesOf } from "@/lib/field";
import { addDaysToKey, dateKey, dayRangeUtc, timeKey, todayKey, weekdayOfKey } from "@/lib/time";
import { fieldErrorsFromZod, geoSchema, optionalText } from "@/lib/validation";
import { prisma, type Tx } from "../db";
import { appointmentScope, assertCan, hasPermission } from "../access";
import type { CurrentUser } from "../auth/session";
import { ForbiddenError, NotFoundError, ValidationError } from "../errors";
import { detectImageType, discardFile, readStoredFile, saveFile } from "../storage";
import { recordAudit } from "./audit";
import { insertCheckIn } from "./field";
import { notifyUsers } from "./notifications";
import { getSettings } from "./settings";

/**
 * Attendance: clocking in and out at the company, a customer's site (a visit of today) or an
 * approved work location, with the phone's location and a live-camera selfie.
 *
 * - The time is the server's (createdAt); the browser sends no time.
 * - The location comes from the browser's Geolocation API with the person's permission. It is
 *   recorded as given, with its accuracy, and compared with the expected place: further than the
 *   geofence radius is flagged "outside", no location is flagged "no location", a reading less
 *   accurate than the configured limit is flagged "low accuracy". Nothing is ever corrected or
 *   guessed. A browser cannot prove a reading is genuine, so flags go to a manager to review.
 * - The selfie is required; the page takes it from the camera stream (not the gallery). The file
 *   type is read from the bytes, the file is private, and only the person and attendance managers
 *   can see it.
 * - Check-ins stay append-only; a manager's review is a separate append-only row.
 */

const TX_OPTIONS = { timeout: 20_000, maxWait: 10_000 };
const MAX_SELFIE_BYTES = 2 * 1024 * 1024;
const dbDate = (key: string) => new Date(`${key}T00:00:00.000Z`);
const keyOf = (d: Date) => d.toISOString().slice(0, 10);
const dec = (d: Prisma.Decimal | null) => (d === null ? null : d.toNumber());

export const ATTENDANCE_SITES: AttendanceSite[] = ["COMPANY", "CUSTOMER", "WORK_LOCATION"];

export const clockSchema = z.object({
  action: z.enum(["IN", "OUT"]),
  site: z.enum(ATTENDANCE_SITES as [AttendanceSite, ...AttendanceSite[]], { error: msg("clock.errors.site") }),
  appointmentId: z.preprocess((v) => (v === "" ? null : v), z.string().max(64).nullable().optional()),
  workLocationId: z.preprocess((v) => (v === "" ? null : v), z.string().max(64).nullable().optional()),
  geo: geoSchema.optional().nullable(),
  /** The camera photo as a data URL (data:image/jpeg;base64,...). */
  selfie: z.string({ error: msg("clock.errors.selfie") }).max(3_000_000, msg("clock.errors.selfieTooLarge")),
  note: optionalText(300),
});

export const workLocationSchema = z.object({
  name: z.preprocess((v) => (typeof v === "string" ? v.trim() : v), z.string({ error: msg("validation.required", { field: "@clock.locationName" }) }).min(1, msg("validation.required", { field: "@clock.locationName" })).max(120)),
  nameAr: optionalText(120),
  latitude: z.coerce.number().min(-90, msg("validation.latitude")).max(90, msg("validation.latitude")),
  longitude: z.coerce.number().min(-180, msg("validation.longitude")).max(180, msg("validation.longitude")),
  radiusM: z.coerce.number().int().min(25, msg("clock.errors.radius")).max(5000, msg("clock.errors.radius")),
  isActive: z.preprocess((v) => (v === "false" ? false : v === "true" ? true : (v ?? true)), z.boolean()),
});

export const reviewSchema = z
  .object({ decision: z.enum(["ACCEPTED", "REJECTED"]), note: optionalText(500) })
  .refine((v) => v.decision !== "REJECTED" || !!v.note, { path: ["note"], message: msg("clock.errors.rejectNote") });

function decodeSelfie(dataUrl: string): Uint8Array {
  const m = /^data:image\/(?:jpeg|png|webp);base64,([A-Za-z0-9+/=]+)$/.exec(dataUrl);
  if (!m) throw new ValidationError({ selfie: msg("clock.errors.selfie") }, msg("clock.errors.selfie"));
  const bytes = new Uint8Array(Buffer.from(m[1]!, "base64"));
  if (bytes.byteLength > MAX_SELFIE_BYTES) throw new ValidationError({ selfie: msg("clock.errors.selfieTooLarge") }, msg("clock.errors.selfieTooLarge"));
  return bytes;
}

export function canClock(user: CurrentUser) {
  return hasPermission(user, "checkins.record") || hasPermission(user, "car.checkin");
}

/** The approved work locations (active ones for the clock page; all for managers). */
export async function listWorkLocations(user: CurrentUser, all = false) {
  if (!canClock(user) && !hasPermission(user, "attendance.manage") && !hasPermission(user, "attendance.view")) throw new NotFoundError();
  const rows = await prisma.workLocation.findMany({ where: all ? {} : { isActive: true }, orderBy: [{ isActive: "desc" }, { name: "asc" }] });
  return rows.map((w) => ({ id: w.id, name: w.name, nameAr: w.nameAr, latitude: w.latitude.toNumber(), longitude: w.longitude.toNumber(), radiusM: w.radiusM, isActive: w.isActive }));
}

export async function saveWorkLocation(user: CurrentUser, id: string | null, raw: unknown) {
  assertCan(user, "attendance.manage");
  const parsed = workLocationSchema.safeParse(raw);
  if (!parsed.success) throw new ValidationError(fieldErrorsFromZod(parsed.error));
  const d = parsed.data;
  return prisma.$transaction(async (tx) => {
    const before = id ? await tx.workLocation.findUnique({ where: { id } }) : null;
    if (id && !before) throw new NotFoundError();
    const data = { ...d, latitude: new Prisma.Decimal(d.latitude.toFixed(6)), longitude: new Prisma.Decimal(d.longitude.toFixed(6)) };
    const w = before ? await tx.workLocation.update({ where: { id: before.id }, data }) : await tx.workLocation.create({ data: { ...data, createdById: user.id } });
    await recordAudit(tx, {
      entityType: "ATTENDANCE",
      entityId: w.id,
      action: before ? "WORK_LOCATION_UPDATED" : "WORK_LOCATION_CREATED",
      summary: msg(before ? "erpAudit.workLocationUpdated" : "erpAudit.workLocationCreated", { name: user.name, location: w.name }),
      changes: { name: w.name, latitude: d.latitude, longitude: d.longitude, radiusM: w.radiusM, isActive: w.isActive },
      actorId: user.id,
    });
    return w.id;
  });
}

/** What the clock page needs: today's clock-in / out, today's visits (customer sites), work locations. */
export async function clockState(user: CurrentUser, now = new Date()) {
  if (!canClock(user)) throw new NotFoundError();
  const settings = await getSettings();
  const tz = settings.timezone;
  const day = todayKey(tz, now);
  const range = dayRangeUtc(day, day, tz);
  const [rows, visits, locations] = await Promise.all([
    prisma.checkIn.findMany({ where: { userId: user.id, day: dbDate(day), kind: { in: ["COMPANY", "LEAVE"] } }, orderBy: { createdAt: "asc" } }),
    prisma.appointment.findMany({
      where: { AND: [appointmentScope(user), { startsAt: { gte: range.start, lt: range.end } }, { technicians: { some: { technicianId: user.id } } }, { status: { kind: { notIn: ["CANCELLED", "POSTPONED"] } } }] },
      orderBy: { startsAt: "asc" },
      select: { id: true, number: true, startsAt: true, customer: { select: { name: true } }, location: { select: { area: true, latitude: true } } },
    }),
    listWorkLocations(user),
  ]);
  const clockIn = rows.find((r) => r.kind === "COMPANY") ?? null;
  const clockOut = rows.find((r) => r.kind === "LEAVE") ?? null;
  return {
    day,
    companySet: settings.companyLatitude !== null,
    clockIn: clockIn && rowDTO(clockIn, settings.maxAccuracyM),
    clockOut: clockOut && rowDTO(clockOut, settings.maxAccuracyM),
    visits: visits.map((v) => ({ id: v.id, code: appointmentCode(v.number), customerName: v.customer.name, area: v.location.area, startsAt: v.startsAt.toISOString(), hasPin: v.location.latitude !== null })),
    workLocations: locations,
  };
}

export type ClockFlags = { outside: boolean; noLocation: boolean; lowAccuracy: boolean; late: boolean; early: boolean };

function flagsOf(r: Pick<CheckIn, "far" | "latitude" | "accuracyM" | "lateMinutes" | "earlyMinutes">, maxAccuracyM: number): ClockFlags {
  return {
    outside: r.far,
    noLocation: r.latitude === null,
    lowAccuracy: r.accuracyM !== null && r.accuracyM > maxAccuracyM,
    late: !!r.lateMinutes,
    early: !!r.earlyMinutes,
  };
}

function rowDTO(r: CheckIn, maxAccuracyM: number) {
  return {
    id: r.id,
    kind: r.kind,
    at: r.createdAt.toISOString(),
    site: r.site,
    distanceM: r.distanceM,
    geofenceM: r.geofenceM,
    accuracyM: r.accuracyM,
    latitude: dec(r.latitude),
    longitude: dec(r.longitude),
    lateMinutes: r.lateMinutes,
    earlyMinutes: r.earlyMinutes,
    hasSelfie: !!r.selfieKey,
    selfieUrl: r.selfieKey ? `/api/attendance/selfie/${r.id}` : null,
    appointmentId: r.relatedAppointmentId,
    flags: flagsOf(r, maxAccuracyM),
  };
}

async function admins(tx: Tx) {
  return (await tx.user.findMany({ where: { role: "ADMIN", isActive: true }, select: { id: true } })).map((u) => u.id);
}

/** Clock in or out. Returns the check-in as recorded (or the one already recorded today). */
export async function clock(user: CurrentUser, raw: unknown, now = new Date()) {
  if (!canClock(user)) throw new ForbiddenError();
  const parsed = clockSchema.safeParse(raw);
  if (!parsed.success) throw new ValidationError(fieldErrorsFromZod(parsed.error));
  const input = parsed.data;
  const bytes = decodeSelfie(input.selfie);
  const type = detectImageType(bytes);
  if (!type) throw new ValidationError({ selfie: msg("attachments.errors.type") }, msg("attachments.errors.type"));
  const settings = await getSettings();
  const tz = settings.timezone;
  const day = todayKey(tz, now);
  const kind = input.action === "IN" ? "COMPANY" : "LEAVE";

  // Where the person should be, and how far from it is still "there".
  let target: { lat: number; lng: number } | null = null;
  let radiusM = settings.companyRadiusM;
  let visit: { id: string; number: number; createdById: string; customerName: string; latitude: number | null; longitude: number | null } | null = null;
  let workLocationId: string | null = null;
  if (input.site === "COMPANY") {
    target = settings.companyLatitude !== null && settings.companyLongitude !== null ? { lat: settings.companyLatitude, lng: settings.companyLongitude } : null;
  } else if (input.site === "CUSTOMER") {
    if (!input.appointmentId) throw new ValidationError({ appointmentId: msg("clock.errors.visit") }, msg("clock.errors.visit"));
    const range = dayRangeUtc(day, day, tz);
    const a = await prisma.appointment.findFirst({
      where: { AND: [{ id: input.appointmentId }, appointmentScope(user)] },
      select: { id: true, number: true, createdById: true, startsAt: true, customer: { select: { name: true } }, location: { select: { latitude: true, longitude: true } }, technicians: { select: { technicianId: true } } },
    });
    if (!a) throw new NotFoundError("errors.appointmentNotFound");
    if (!a.technicians.some((t) => t.technicianId === user.id)) throw new ForbiddenError("field.errors.notAssigned");
    if (a.startsAt < range.start || a.startsAt >= range.end) throw new ValidationError({ appointmentId: msg("clock.errors.visitToday") }, msg("clock.errors.visitToday"));
    visit = { id: a.id, number: a.number, createdById: a.createdById, customerName: a.customer.name, latitude: dec(a.location.latitude), longitude: dec(a.location.longitude) };
    target = visit.latitude !== null && visit.longitude !== null ? { lat: visit.latitude, lng: visit.longitude } : null;
    radiusM = settings.customerRadiusM;
  } else {
    const w = input.workLocationId ? await prisma.workLocation.findUnique({ where: { id: input.workLocationId } }) : null;
    if (!w || !w.isActive) throw new ValidationError({ workLocationId: msg("clock.errors.workLocation") }, msg("clock.errors.workLocation"));
    workLocationId = w.id;
    target = { lat: w.latitude.toNumber(), lng: w.longitude.toNumber() };
    radiusM = w.radiusM;
  }

  const key = await saveFile(bytes, type, now);
  try {
    const result = await prisma.$transaction(async (tx) => {
      if (kind === "LEAVE" && !(await tx.checkIn.findFirst({ where: { userId: user.id, kind: "COMPANY", day: dbDate(day) }, select: { id: true } }))) {
        throw new ValidationError({ action: msg("field.errors.companyFirst") }, msg("field.errors.companyFirst"));
      }
      const { row, duplicate } = await insertCheckIn(tx, user, kind, null, input.geo ?? null, settings, {
        note: input.note,
        dayUnique: true,
        target: { geo: target, radiusM },
        attendance: { site: input.site, workLocationId, relatedAppointmentId: visit?.id ?? null, selfieKey: key, selfieContentType: type, selfieSha256: createHash("sha256").update(bytes).digest("hex") },
      }, now);
      if (duplicate) return { row, duplicate };
      const time = timeKey(now, tz);
      const flags = flagsOf(row, settings.maxAccuracyM);
      if (kind === "COMPANY" && row.lateMinutes) await notifyUsers(tx, await admins(tx), { type: "LATE", message: msg("notify.lateArrival", { name: user.name, time, minutes: row.lateMinutes }) }, user.id);
      if (kind === "LEAVE" && row.earlyMinutes) await notifyUsers(tx, await admins(tx), { type: "LATE", message: msg("notify.earlyLeave", { name: user.name, time, minutes: row.earlyMinutes }) }, user.id);
      if (flags.outside || flags.noLocation) {
        await notifyUsers(tx, await admins(tx), {
          type: "ATTENDANCE",
          message: flags.noLocation ? msg("clock.notifyNoLocation", { name: user.name, time }) : msg("clock.notifyOutside", { name: user.name, time, metres: row.distanceM ?? 0 }),
        }, user.id);
      }
      await recordAudit(tx, {
        entityType: "ATTENDANCE",
        entityId: row.id,
        action: kind === "COMPANY" ? "CLOCK_IN" : "CLOCK_OUT",
        summary: msg(kind === "COMPANY" ? "erpAudit.clockIn" : "erpAudit.clockOut", { name: user.name, time, site: `@clock.sites.${input.site}` }),
        changes: { site: input.site, distanceM: row.distanceM, geofenceM: row.geofenceM, accuracyM: row.accuracyM, flags },
        actorId: user.id,
        appointmentId: visit?.id ?? null,
      });
      return { row, duplicate };
    }, TX_OPTIONS);
    if (result.duplicate) await discardFile(key).catch(() => undefined);
    return { ...rowDTO(result.row, settings.maxAccuracyM), duplicate: result.duplicate };
  } catch (e) {
    await discardFile(key).catch(() => undefined);
    throw e;
  }
}

/** The selfie of a check-in: the person themself and attendance managers only (404 otherwise). */
export async function readSelfie(user: CurrentUser, checkInId: string) {
  if (typeof checkInId !== "string" || checkInId.length > 64) throw new NotFoundError();
  const row = await prisma.checkIn.findUnique({ where: { id: checkInId }, select: { userId: true, selfieKey: true, selfieContentType: true } });
  if (!row?.selfieKey) throw new NotFoundError();
  if (row.userId !== user.id && !hasPermission(user, "attendance.view") && !hasPermission(user, "attendance.manage")) throw new NotFoundError();
  return { bytes: await readStoredFile(row.selfieKey), contentType: row.selfieContentType ?? "image/jpeg" };
}

/** A manager accepts or rejects a flagged clock-in / out (append-only; the latest decision counts). */
export async function reviewCheckIn(user: CurrentUser, checkInId: string, raw: unknown) {
  assertCan(user, "attendance.manage");
  const parsed = reviewSchema.safeParse(raw);
  if (!parsed.success) throw new ValidationError(fieldErrorsFromZod(parsed.error));
  return prisma.$transaction(async (tx) => {
    const c = await tx.checkIn.findUnique({ where: { id: checkInId }, select: { id: true, kind: true, user: { select: { id: true, name: true } } } });
    if (!c || (c.kind !== "COMPANY" && c.kind !== "LEAVE")) throw new NotFoundError();
    const r = await tx.attendanceReview.create({ data: { checkInId: c.id, decision: parsed.data.decision, note: parsed.data.note, reviewedById: user.id } });
    await recordAudit(tx, {
      entityType: "ATTENDANCE",
      entityId: c.id,
      action: parsed.data.decision === "ACCEPTED" ? "ATTENDANCE_ACCEPTED" : "ATTENDANCE_REJECTED",
      summary: msg(parsed.data.decision === "ACCEPTED" ? "erpAudit.attendanceAccepted" : "erpAudit.attendanceRejected", { name: user.name, person: c.user.name, note: parsed.data.note ?? "" }),
      changes: { decision: parsed.data.decision, note: parsed.data.note },
      actorId: user.id,
    });
    return { id: r.id };
  });
}

// ---- Reports -----------------------------------------------------------------------------------

export type DayStatus = "present" | "absent" | "leave" | "dayOff" | "notYet";
export type AttendanceDayRow = {
  person: { id: string; name: string; role: string };
  day: string;
  status: DayStatus;
  leaveType: string | null;
  clockIn: ReturnType<typeof rowDTO> | null;
  clockOut: ReturnType<typeof rowDTO> | null;
  missingCheckout: boolean;
  workedMinutes: number | null;
  visits: { id: string; code: string; customerName: string }[];
  review: { decision: "ACCEPTED" | "REJECTED"; note: string | null; by: string; at: string } | null;
  needsReview: boolean;
};

/**
 * Attendance of field staff (technicians and the driver) for a range of company-local days: who
 * clocked in, where, when, how far from where they should be, the selfie, clock-out, worked time,
 * missing clock-outs (past days, or more than two hours after the end of today's working day),
 * leave, absences (a working day with a visit and no clock-in), and the latest review.
 */
export async function attendanceRange(user: CurrentUser, fromRaw: string | undefined, toRaw: string | undefined, opts: { userId?: string } = {}, now = new Date()) {
  const all = hasPermission(user, "attendance.view") || hasPermission(user, "attendance.manage");
  if (!all && !canClock(user)) throw new NotFoundError();
  const settings = await getSettings();
  const tz = settings.timezone;
  const today = todayKey(tz, now);
  const valid = (k?: string) => (k && /^\d{4}-\d{2}-\d{2}$/.test(k) ? k : null);
  const to = valid(toRaw) ?? today;
  const from0 = valid(fromRaw) ?? to;
  const from = from0 > to ? to : from0 < addDaysToKey(to, -62) ? addDaysToKey(to, -62) : from0;
  const days: string[] = [];
  for (let d = from; d <= to; d = addDaysToKey(d, 1)) days.push(d);
  const peopleWhere: Prisma.UserWhereInput = all ? { role: { in: ["TECHNICIAN", "DRIVER"] }, isActive: true, ...(opts.userId ? { id: opts.userId } : {}) } : { id: user.id };
  const range = dayRangeUtc(from, to, tz);
  const [people, checks, leaves, visits] = await Promise.all([
    prisma.user.findMany({ where: peopleWhere, select: { id: true, name: true, role: true }, orderBy: { name: "asc" } }),
    prisma.checkIn.findMany({
      where: { day: { gte: dbDate(from), lte: dbDate(to) }, kind: { in: ["COMPANY", "LEAVE", "CAR_GO", "CAR_BACK"] }, user: peopleWhere },
      orderBy: { createdAt: "asc" },
      include: { reviews: { orderBy: { createdAt: "desc" }, take: 1, include: { reviewedBy: { select: { name: true } } } } },
    }),
    prisma.technicianLeave.findMany({ where: { status: "APPROVED", startDate: { lte: dbDate(to) }, endDate: { gte: dbDate(from) }, user: peopleWhere }, select: { userId: true, startDate: true, endDate: true, type: true } }),
    prisma.appointment.findMany({
      where: { startsAt: { gte: range.start, lt: range.end }, status: { kind: { notIn: ["CANCELLED", "POSTPONED"] } }, technicians: { some: { technician: peopleWhere } } },
      select: { id: true, number: true, startsAt: true, customer: { select: { name: true } }, technicians: { select: { technicianId: true } } },
    }),
  ]);
  const endMin = minutesOf(settings.workEnd);
  const nowMin = minutesOf(timeKey(now, tz));
  const rows: AttendanceDayRow[] = [];
  for (const p of people) {
    for (const d of days) {
      const mine = checks.filter((c) => c.userId === p.id && keyOf(c.day) === d);
      const inRow = mine.find((c) => c.kind === "COMPANY") ?? mine.find((c) => c.kind === "CAR_GO") ?? null;
      const outRow = mine.find((c) => c.kind === "LEAVE") ?? mine.find((c) => c.kind === "CAR_BACK") ?? null;
      const leave = leaves.find((l) => l.userId === p.id && keyOf(l.startDate) <= d && keyOf(l.endDate) >= d) ?? null;
      const dayVisits = visits.filter((v) => v.technicians.some((t) => t.technicianId === p.id) && dateKey(v.startsAt, tz) === d);
      const closed = settings.closedWeekdays.includes(weekdayOfKey(d));
      const status: DayStatus = inRow ? "present" : leave ? "leave" : closed ? "dayOff" : d > today || (d === today && nowMin < minutesOf(settings.workStart) + settings.workGraceMinutes) ? "notYet" : dayVisits.length || !closed ? (d === today && !dayVisits.length ? "notYet" : "absent") : "dayOff";
      const missingCheckout = !!inRow && !outRow && (d < today || nowMin > endMin + 120);
      const review = [inRow, outRow].map((r) => r?.reviews[0]).filter(Boolean).sort((a, b) => b!.createdAt.getTime() - a!.createdAt.getTime())[0];
      const ci = inRow ? rowDTO(inRow, settings.maxAccuracyM) : null;
      const co = outRow ? rowDTO(outRow, settings.maxAccuracyM) : null;
      const flagged = [ci, co].some((r) => r && (r.flags.outside || r.flags.noLocation || r.flags.lowAccuracy));
      rows.push({
        person: p,
        day: d,
        status,
        leaveType: leave?.type ?? null,
        clockIn: ci,
        clockOut: co,
        missingCheckout,
        workedMinutes: inRow && outRow ? Math.round((outRow.createdAt.getTime() - inRow.createdAt.getTime()) / 60_000) : null,
        visits: dayVisits.map((v) => ({ id: v.id, code: appointmentCode(v.number), customerName: v.customer.name })),
        review: review ? { decision: review.decision, note: review.note, by: review.reviewedBy.name, at: review.createdAt.toISOString() } : null,
        needsReview: (flagged || missingCheckout) && !review,
      });
    }
  }
  const summary = people.map((p) => {
    const mine = rows.filter((r) => r.person.id === p.id);
    return {
      person: p,
      present: mine.filter((r) => r.status === "present").length,
      absent: mine.filter((r) => r.status === "absent").length,
      leave: mine.filter((r) => r.status === "leave").length,
      late: mine.filter((r) => r.clockIn?.flags.late).length,
      lateMinutes: mine.reduce((s, r) => s + (r.clockIn?.lateMinutes ?? 0), 0),
      early: mine.filter((r) => r.clockOut?.flags.early).length,
      missingCheckout: mine.filter((r) => r.missingCheckout).length,
      flagged: mine.filter((r) => [r.clockIn, r.clockOut].some((x) => x && (x.flags.outside || x.flags.noLocation || x.flags.lowAccuracy))).length,
      workedMinutes: mine.reduce((s, r) => s + (r.workedMinutes ?? 0), 0),
    };
  });
  return { from, to, today, days, rows, summary, canReview: hasPermission(user, "attendance.manage"), maxAccuracyM: settings.maxAccuracyM };
}
export type AttendanceRange = Awaited<ReturnType<typeof attendanceRange>>;
