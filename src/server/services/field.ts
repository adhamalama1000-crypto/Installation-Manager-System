import "server-only";
import { Prisma, type CheckInKind } from "@prisma/client";
import { msg } from "@/i18n/translator";
import { appointmentCode } from "@/lib/constants";
import { CLIENT_FAULT, distanceM, etaMinutes, FAR_FROM_COMPANY_M, FAR_FROM_CUSTOMER_M, minutesOf, monthlyPoints, PROBLEM_REASONS, type Geo, type ProblemReason } from "@/lib/field";
import { addDaysToKey, addMonthsToKey, dateKey, dayRangeUtc, startOfMonthKey, timeKey, todayKey, weekdayOfKey } from "@/lib/time";
import { checkInSchema, fieldErrorsFromZod, geoSchema, type SettingsValues } from "@/lib/validation";
import type { CheckInDTO } from "@/lib/types";
import { prisma, type Tx } from "../db";
import { appointmentScope, assertCan, hasPermission } from "../access";
import type { CurrentUser } from "../auth/session";
import { ForbiddenError, NotFoundError, ValidationError } from "../errors";
import { moneyParam } from "../i18n-params";
import { recordAudit } from "./audit";
import { notifyUsers } from "./notifications";
import { getSettings } from "./settings";

/**
 * Field tracking from Aura: check-ins with the phone's location at each stage of a technician's
 * day (Code.gs checkin_ / api_checkin), the live board (api_live), late alerts (lateItems_ /
 * lateCheck), attendance (attendance_) and monthly points (api_stats). Locations come only from
 * the browser's Geolocation API with the user's permission; when there is none the check-in is
 * recorded without coordinates and shown as such, never guessed.
 */

const TX_OPTIONS = { timeout: 20_000, maxWait: 10_000 };
/** `@db.Date` columns are read and written as UTC midnight. */
const dbDate = (key: string) => new Date(`${key}T00:00:00.000Z`);
const keyOf = (d: Date) => d.toISOString().slice(0, 10);
const num = (d: Prisma.Decimal | null) => (d === null ? null : d.toNumber());

export type GeoInput = { lat: number; lng: number; acc?: number };

type VisitForCheckIn = {
  id: string;
  number: number;
  createdById: string;
  customerName: string;
  latitude: number | null;
  longitude: number | null;
};

function companyGeo(s: SettingsValues): Geo | null {
  return s.companyLatitude !== null && s.companyLongitude !== null ? { lat: s.companyLatitude, lng: s.companyLongitude } : null;
}

async function admins(tx: Tx) {
  return (await tx.user.findMany({ where: { role: "ADMIN", isActive: true }, select: { id: true } })).map((u) => u.id);
}

/**
 * Records a check-in with Aura's flags (far from the company or the customer, late arrival,
 * early leave, expected arrival on "on my way"). A stage already recorded today for the same
 * visit is returned instead of repeated (except problems). Runs inside the caller's transaction.
 */
export async function insertCheckIn(
  tx: Tx,
  user: { id: string; name: string },
  kind: CheckInKind,
  visit: VisitForCheckIn | null,
  geo: GeoInput | null,
  settings: SettingsValues,
  extra: { reason?: ProblemReason | null; note?: string | null } = {},
  now: Date = new Date(),
) {
  const tz = settings.timezone;
  const day = todayKey(tz, now);
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`checkin:${user.id}`}))`;
  if (kind !== "PROBLEM") {
    const dup = await tx.checkIn.findFirst({ where: { userId: user.id, kind, day: dbDate(day), appointmentId: visit?.id ?? null } });
    if (dup) return { row: dup, duplicate: true };
  }
  const hhmm = timeKey(now, tz);
  const company = companyGeo(settings);
  const client = visit && visit.latitude !== null && visit.longitude !== null ? { lat: visit.latitude, lng: visit.longitude } : null;
  let distance: number | null = null;
  let etaAt: Date | null = null;
  let late: number | null = null;
  let early: number | null = null;
  let far = false;
  if (kind === "COMPANY") {
    if (geo && company) {
      distance = distanceM(geo, company);
      far = distance > FAR_FROM_COMPANY_M;
    }
    if (minutesOf(hhmm) > minutesOf(settings.workStart) + settings.workGraceMinutes) late = minutesOf(hhmm) - minutesOf(settings.workStart);
  } else if (kind === "LEAVE") {
    if (geo && company) distance = distanceM(geo, company);
    if (minutesOf(hhmm) < minutesOf(settings.workEnd)) early = minutesOf(settings.workEnd) - minutesOf(hhmm);
  } else if (geo && client) {
    if (kind === "DEPART") etaAt = new Date(now.getTime() + etaMinutes(geo, client, Number(hhmm.slice(0, 2))) * 60_000);
    else {
      distance = distanceM(geo, client);
      far = (kind === "ARRIVE" || kind === "START") && distance > FAR_FROM_CUSTOMER_M;
    }
  }
  const row = await tx.checkIn.create({
    data: {
      userId: user.id,
      kind,
      appointmentId: visit?.id ?? null,
      day: dbDate(day),
      latitude: geo ? new Prisma.Decimal(geo.lat.toFixed(6)) : null,
      longitude: geo ? new Prisma.Decimal(geo.lng.toFixed(6)) : null,
      accuracyM: geo?.acc !== undefined ? Math.round(geo.acc) : null,
      distanceM: distance,
      etaAt,
      lateMinutes: late,
      earlyMinutes: early,
      far,
      reason: kind === "PROBLEM" ? (extra.reason ?? null) : null,
      note: extra.note ?? null,
      createdAt: now,
    },
  });
  if (geo && kind !== "LEAVE") {
    await tx.technicianPosition.upsert({
      where: { userId: user.id },
      create: { userId: user.id, latitude: row.latitude!, longitude: row.longitude!, accuracyM: row.accuracyM, at: now },
      update: { latitude: row.latitude!, longitude: row.longitude!, accuracyM: row.accuracyM, at: now },
    });
  }
  return { row, duplicate: false };
}

type Row = Prisma.CheckInGetPayload<{ include: { user: { select: { id: true; name: true } } } }>;

function toDTO(r: Row, duplicate?: boolean): CheckInDTO {
  return {
    id: r.id,
    kind: r.kind,
    at: r.createdAt.toISOString(),
    user: r.user,
    appointmentId: r.appointmentId,
    hasLocation: r.latitude !== null,
    distanceM: r.distanceM,
    etaAt: r.etaAt?.toISOString() ?? null,
    lateMinutes: r.lateMinutes,
    earlyMinutes: r.earlyMinutes,
    far: r.far,
    reason: r.reason,
    note: r.note,
    ...(duplicate ? { duplicate: true } : {}),
  };
}

const visitSelect = {
  id: true,
  number: true,
  createdById: true,
  customer: { select: { name: true } },
  location: { select: { latitude: true, longitude: true } },
  status: { select: { kind: true } },
  extraFee: true,
  version: true,
  technicians: { select: { technicianId: true } },
} satisfies Prisma.AppointmentSelect;

/** A check-in from the technician's phone (COMPANY, PICKUP, READY, DEPART, ARRIVE, PROBLEM, LEAVE). */
export async function recordCheckIn(user: CurrentUser, raw: unknown, now: Date = new Date()): Promise<CheckInDTO> {
  assertCan(user, "checkins.record");
  const parsed = checkInSchema.safeParse(raw);
  if (!parsed.success) throw new ValidationError(fieldErrorsFromZod(parsed.error));
  const { kind, geo, note } = parsed.data;
  // START and DONE are recorded with the visit outcome, so the status and the check-in agree.
  if (kind === "START" || kind === "DONE") throw new ValidationError({ kind: msg("field.errors.useOutcome") }, msg("field.errors.useOutcome"));
  const settings = await getSettings();
  const dayVisit = kind !== "COMPANY" && kind !== "LEAVE";
  let reason: ProblemReason | null = null;
  if (kind === "PROBLEM") {
    if (!PROBLEM_REASONS.includes(parsed.data.reason as ProblemReason)) throw new ValidationError({ reason: msg("field.errors.reason") }, msg("field.errors.reason"));
    reason = parsed.data.reason as ProblemReason;
  }

  const result = await prisma.$transaction(async (tx) => {
    const day = dbDate(todayKey(settings.timezone, now));
    let visit: Prisma.AppointmentGetPayload<{ select: typeof visitSelect }> | null = null;
    if (dayVisit) {
      const id = parsed.data.appointmentId;
      if (!id) throw new ValidationError({ appointmentId: msg("validation.invalid") });
      visit = await tx.appointment.findFirst({ where: { AND: [{ id }, appointmentScope(user)] }, select: visitSelect });
      if (!visit) throw new NotFoundError("errors.appointmentNotFound");
      if (!visit.technicians.some((t) => t.technicianId === user.id)) throw new ForbiddenError("field.errors.notAssigned");
      if (visit.status.kind === "CANCELLED" || visit.status.kind === "POSTPONED") throw new ValidationError({ kind: msg("field.errors.inactive") }, msg("field.errors.inactive"));
      // Aura: call the customer first and confirm the site is ready before setting off.
      if (kind === "DEPART" && !(await tx.checkIn.findFirst({ where: { userId: user.id, kind: "READY", appointmentId: id, day }, select: { id: true } }))) {
        throw new ValidationError({ kind: msg("field.errors.readyFirst") }, msg("field.errors.readyFirst"));
      }
    } else if (kind === "LEAVE" && !(await tx.checkIn.findFirst({ where: { userId: user.id, kind: "COMPANY", day }, select: { id: true } }))) {
      throw new ValidationError({ kind: msg("field.errors.companyFirst") }, msg("field.errors.companyFirst"));
    }

    const v: VisitForCheckIn | null = visit
      ? { id: visit.id, number: visit.number, createdById: visit.createdById, customerName: visit.customer.name, latitude: num(visit.location.latitude), longitude: num(visit.location.longitude) }
      : null;
    const { row, duplicate } = await insertCheckIn(tx, user, kind, v, geo ?? null, settings, { reason, note }, now);
    if (duplicate) return { row, duplicate };

    // A problem the customer caused adds the repeat-visit fee once (Aura REVISIT_FEE).
    if (visit && reason && CLIENT_FAULT.includes(reason) && settings.revisitFee > 0 && (visit.extraFee === null || visit.extraFee.isZero())) {
      await tx.appointment.update({ where: { id: visit.id }, data: { extraFee: settings.revisitFee, updatedById: user.id, version: { increment: 1 } } });
      await recordAudit(tx, {
        entityType: "APPOINTMENT",
        entityId: visit.id,
        appointmentId: visit.id,
        action: "REVISIT_FEE",
        summary: msg("audit.revisitFee", { code: appointmentCode(visit.number), reason: `@field.reasons.${reason}`, ...moneyParam("fee", settings.revisitFee) }),
        changes: { extraFee: { from: num(visit.extraFee), to: settings.revisitFee } },
        actorId: user.id,
      });
    }

    const tz = settings.timezone;
    const time = timeKey(now, tz);
    if (visit && v) {
      const code = appointmentCode(visit.number);
      if (kind === "DEPART") {
        await notifyUsers(tx, [visit.createdById], {
          appointmentId: visit.id,
          type: "FIELD",
          message: row.etaAt
            ? msg("notify.onTheWayEta", { name: user.name, customer: v.customerName, code, eta: timeKey(row.etaAt, tz) })
            : msg("notify.onTheWay", { name: user.name, customer: v.customerName, code }),
        }, user.id);
      } else if (kind === "ARRIVE") {
        await notifyUsers(tx, [visit.createdById], {
          appointmentId: visit.id,
          type: "FIELD",
          message: row.far && row.distanceM !== null
            ? msg("notify.arrivedFar", { name: user.name, customer: v.customerName, code, metres: row.distanceM })
            : msg("notify.arrived", { name: user.name, customer: v.customerName, code }),
        }, user.id);
      } else if (kind === "PROBLEM") {
        await notifyUsers(tx, [visit.createdById, ...(await admins(tx))], {
          appointmentId: visit.id,
          type: "FIELD",
          message: msg("notify.problem", { name: user.name, customer: v.customerName, code, reason: `@field.reasons.${reason}`, note: note ?? "" }),
        }, user.id);
      }
    } else if (kind === "COMPANY" && row.lateMinutes) {
      await notifyUsers(tx, await admins(tx), { type: "LATE", message: msg("notify.lateArrival", { name: user.name, time, minutes: row.lateMinutes }) }, user.id);
    } else if (kind === "LEAVE" && row.earlyMinutes) {
      await notifyUsers(tx, await admins(tx), { type: "LATE", message: msg("notify.earlyLeave", { name: user.name, time, minutes: row.earlyMinutes }) }, user.id);
    }
    return { row, duplicate };
  }, TX_OPTIONS);
  return toDTO({ ...result.row, user: { id: user.id, name: user.name } }, result.duplicate);
}

/** The technician's position while on the way (sent every few minutes from the open visit page). */
export async function recordPosition(user: CurrentUser, raw: unknown, now: Date = new Date()) {
  assertCan(user, "checkins.record");
  const parsed = geoSchema.safeParse(raw);
  if (!parsed.success) throw new ValidationError(fieldErrorsFromZod(parsed.error));
  const g = parsed.data;
  const data = { latitude: new Prisma.Decimal(g.lat.toFixed(6)), longitude: new Prisma.Decimal(g.lng.toFixed(6)), accuracyM: g.acc !== undefined ? Math.round(g.acc) : null, at: now };
  await prisma.technicianPosition.upsert({ where: { userId: user.id }, create: { userId: user.id, ...data }, update: data });
  return { ok: true };
}

/** Check-ins of a visit: the technician's own today, or every technician's for those who manage it. */
export async function visitCheckIns(user: CurrentUser, appointmentId: string): Promise<CheckInDTO[]> {
  if (!hasPermission(user, "checkins.record") && !hasPermission(user, "board.view") && !hasPermission(user, "appointments.manage")) return [];
  const own = !hasPermission(user, "board.view") && !hasPermission(user, "appointments.manage");
  const rows = await prisma.checkIn.findMany({
    where: { appointmentId, ...(own ? { userId: user.id } : {}), appointment: appointmentScope(user) },
    include: { user: { select: { id: true, name: true } } },
    orderBy: { createdAt: "asc" },
    take: 200,
  });
  return rows.map((r) => toDTO(r));
}

/** Today's company and leave check-ins of the signed-in technician. */
export async function myDay(user: CurrentUser, now: Date = new Date()) {
  if (!hasPermission(user, "checkins.record")) return null;
  const tz = user.settings.timezone;
  const rows = await prisma.checkIn.findMany({
    where: { userId: user.id, day: dbDate(todayKey(tz, now)), kind: { in: ["COMPANY", "LEAVE"] } },
    include: { user: { select: { id: true, name: true } } },
    orderBy: { createdAt: "asc" },
  });
  const company = rows.find((r) => r.kind === "COMPANY");
  const leave = rows.find((r) => r.kind === "LEAVE");
  return { company: company ? toDTO(company) : null, leave: leave ? toDTO(leave) : null, companySet: companyGeo(user.settings) !== null };
}

// ---------------------------------------------------------------------------------------------
// Live board
// ---------------------------------------------------------------------------------------------

export type BoardTone = "red" | "yellow" | "green" | "grey";
export type BoardState = "leave" | "problem" | "atClient" | "onWay" | "finished" | "atCompany" | "notYet" | "free";
export type BoardVisit = {
  id: string;
  code: string;
  customerName: string;
  area: string | null;
  startsAt: string;
  statusKind: string;
  closed: boolean;
  stages: Partial<Record<CheckInKind, { at: string; far: boolean; etaAt: string | null; reason: string | null }>>;
};
export type BoardRow = {
  technician: { id: string; name: string; phone: string | null };
  state: BoardState;
  tone: BoardTone;
  /** When the current state began (company check-in, arrival, start). */
  since: string | null;
  /** Expected arrival while on the way (refreshed from the latest position when fresh). */
  etaAt: string | null;
  far: boolean;
  problemReason: string | null;
  leaveType: string | null;
  current: { customerName: string; area: string | null } | null;
  next: { customerName: string; area: string | null; startsAt: string } | null;
  companyAt: string | null;
  companyFar: boolean;
  visits: BoardVisit[];
  /** Latest position age in minutes (null = none today). */
  positionAgeMin: number | null;
};

export async function liveBoard(user: CurrentUser, now: Date = new Date()): Promise<{ day: string; rows: BoardRow[] }> {
  assertCan(user, "board.view");
  const tz = user.settings.timezone;
  const day = todayKey(tz, now);
  const range = dayRangeUtc(day, day, tz);
  const [technicians, visits, checkIns, leaves, positions] = await Promise.all([
    prisma.user.findMany({ where: { role: "TECHNICIAN", isActive: true }, select: { id: true, name: true, phone: true }, orderBy: { name: "asc" } }),
    prisma.appointment.findMany({
      where: { startsAt: { gte: range.start, lt: range.end }, status: { kind: { notIn: ["CANCELLED", "POSTPONED"] } } },
      select: {
        id: true,
        number: true,
        startsAt: true,
        status: { select: { kind: true } },
        customer: { select: { name: true } },
        location: { select: { area: true, latitude: true, longitude: true } },
        technicians: { select: { technicianId: true } },
      },
      orderBy: [{ startsAt: "asc" }, { number: "asc" }],
    }),
    prisma.checkIn.findMany({ where: { day: dbDate(day) }, orderBy: { createdAt: "asc" } }),
    prisma.technicianLeave.findMany({ where: { status: "APPROVED", startDate: { lte: dbDate(day) }, endDate: { gte: dbDate(day) } }, select: { userId: true, type: true } }),
    prisma.technicianPosition.findMany(),
  ]);
  const canLocation = hasPermission(user, "location.view");
  const hhmm = timeKey(now, tz);
  const rows: BoardRow[] = technicians.map((tech) => {
    const mine = checkIns.filter((c) => c.userId === tech.id);
    const company = mine.find((c) => c.kind === "COMPANY") ?? null;
    const pos = positions.find((p) => p.userId === tech.id);
    const posAge = pos ? Math.round((now.getTime() - pos.at.getTime()) / 60_000) : null;
    const vs = visits
      .filter((v) => v.technicians.some((t) => t.technicianId === tech.id))
      .map((v) => {
        const stages: BoardVisit["stages"] = {};
        for (const c of mine) if (c.appointmentId === v.id && !stages[c.kind]) stages[c.kind] = { at: c.createdAt.toISOString(), far: c.far, etaAt: c.etaAt?.toISOString() ?? null, reason: c.reason };
        const closed = !!stages.DONE || ["COMPLETED", "NEEDS_REVISIT", "UNABLE_TO_COMPLETE"].includes(v.status.kind);
        return {
          raw: v,
          visit: {
            id: v.id,
            code: appointmentCode(v.number),
            customerName: v.customer.name,
            area: canLocation ? v.location.area : null,
            startsAt: v.startsAt.toISOString(),
            statusKind: v.status.kind,
            closed,
            stages,
          } satisfies BoardVisit,
        };
      });
    const cur = vs.find((x) => !x.visit.closed && (x.visit.stages.DEPART || x.visit.stages.ARRIVE || x.visit.stages.START || x.visit.stages.PROBLEM)) ?? null;
    const next = vs.find((x) => !x.visit.closed && x !== cur) ?? null;
    const leave = leaves.find((l) => l.userId === tech.id) ?? null;
    let state: BoardState = "free";
    let tone: BoardTone = "grey";
    let since: string | null = null;
    let etaAt: string | null = null;
    let far = false;
    if (leave) {
      state = "leave";
      tone = vs.length ? "red" : "grey";
    } else if (vs.length) {
      const st = cur?.visit.stages;
      if (cur && st?.PROBLEM && !st.ARRIVE) {
        state = "problem";
        tone = "red";
      } else if (cur && st && (st.ARRIVE || st.START)) {
        state = "atClient";
        tone = st.PROBLEM ? "red" : st.ARRIVE?.far ? "yellow" : "green";
        far = !!st.ARRIVE?.far;
        since = (st.START ?? st.ARRIVE)!.at;
      } else if (cur && st?.DEPART) {
        state = "onWay";
        etaAt = st.DEPART.etaAt;
        const lat = num(cur.raw.location.latitude);
        const lng = num(cur.raw.location.longitude);
        // A position from the last 30 minutes gives a fresher estimate (Aura api_live).
        if (pos && posAge !== null && posAge <= 30 && lat !== null && lng !== null) {
          etaAt = new Date(now.getTime() + etaMinutes({ lat: pos.latitude.toNumber(), lng: pos.longitude.toNumber() }, { lat, lng }, Number(hhmm.slice(0, 2))) * 60_000).toISOString();
        }
        const startAt = cur.raw.startsAt.getTime();
        tone = etaAt && now.getTime() > Date.parse(etaAt) + 10 * 60_000 ? "red" : etaAt && Date.parse(etaAt) > startAt + 15 * 60_000 ? "yellow" : "green";
        since = st.DEPART.at;
      } else if (vs.every((x) => x.visit.closed)) {
        state = "finished";
        tone = "green";
      } else if (company) {
        state = "atCompany";
        since = company.createdAt.toISOString();
        const nextAt = next?.raw.startsAt.getTime();
        tone = nextAt && now.getTime() > nextAt ? "red" : nextAt && now.getTime() > nextAt - 30 * 60_000 ? "yellow" : "green";
      } else {
        state = "notYet";
        tone = minutesOf(hhmm) >= minutesOf(user.settings.workStart) ? "red" : "grey";
      }
    }
    return {
      technician: tech,
      state,
      tone,
      since,
      etaAt,
      far,
      problemReason: cur?.visit.stages.PROBLEM?.reason ?? null,
      leaveType: leave?.type ?? null,
      current: cur ? { customerName: cur.visit.customerName, area: cur.visit.area } : null,
      next: next ? { customerName: next.visit.customerName, area: next.visit.area, startsAt: next.visit.startsAt } : null,
      companyAt: company?.createdAt.toISOString() ?? null,
      companyFar: !!company?.far,
      visits: vs.map((x) => x.visit),
      positionAgeMin: posAge !== null && pos && dateKey(pos.at, tz) === day ? posAge : null,
    };
  });
  const rank: Record<BoardTone, number> = { red: 0, yellow: 1, green: 2, grey: 3 };
  rows.sort((a, b) => rank[a.tone] - rank[b.tone] || b.visits.length - a.visits.length || a.technician.name.localeCompare(b.technician.name));
  return { day, rows };
}

// ---------------------------------------------------------------------------------------------
// Late alerts
// ---------------------------------------------------------------------------------------------

/** What is late right now (Aura lateItems_): no company check-in, not arrived, or past the expected arrival. */
export async function lateItems(now: Date = new Date()) {
  const settings = await getSettings();
  const tz = settings.timezone;
  const day = todayKey(tz, now);
  const hhmm = timeKey(now, tz);
  if (settings.closedWeekdays.includes(weekdayOfKey(day)) || minutesOf(hhmm) < minutesOf(settings.workStart) || hhmm > "20:30") return { day, items: [] };
  const range = dayRangeUtc(day, day, tz);
  const [visits, checkIns] = await Promise.all([
    prisma.appointment.findMany({
      where: { startsAt: { gte: range.start, lt: range.end }, status: { kind: { in: ["SCHEDULED", "IN_PROGRESS"] } } },
      select: { id: true, number: true, startsAt: true, customer: { select: { name: true } }, technicians: { select: { technician: { select: { id: true, name: true, isActive: true, role: true } } } } },
    }),
    prisma.checkIn.findMany({ where: { day: dbDate(day) }, select: { userId: true, kind: true, appointmentId: true, etaAt: true } }),
  ]);
  const items: { key: string; message: string; appointmentId: string | null }[] = [];
  const techs = new Map<string, { id: string; name: string }>();
  for (const v of visits) for (const t of v.technicians) if (t.technician.isActive && t.technician.role === "TECHNICIAN") techs.set(t.technician.id, t.technician);
  for (const tech of techs.values()) {
    const mine = checkIns.filter((c) => c.userId === tech.id);
    if (!mine.some((c) => c.kind === "COMPANY")) items.push({ key: `co|${tech.id}`, message: msg("notify.lateNoCompany", { name: tech.name }), appointmentId: null });
    for (const v of visits.filter((x) => x.technicians.some((t) => t.technician.id === tech.id))) {
      const there = mine.some((c) => c.appointmentId === v.id && (c.kind === "ARRIVE" || c.kind === "DONE" || c.kind === "PROBLEM"));
      if (there) continue;
      const code = appointmentCode(v.number);
      const dep = mine.find((c) => c.appointmentId === v.id && c.kind === "DEPART");
      if (dep) {
        // On the way: judged by the expected arrival rather than the start time.
        if (dep.etaAt && now.getTime() >= dep.etaAt.getTime() + 20 * 60_000) {
          items.push({ key: `eta|${v.id}|${tech.id}`, message: msg("notify.lateEta", { name: tech.name, customer: v.customer.name, code, eta: timeKey(dep.etaAt, tz) }), appointmentId: v.id });
        }
        continue;
      }
      if (now.getTime() >= v.startsAt.getTime() + 30 * 60_000) {
        items.push({ key: `ar|${v.id}|${tech.id}`, message: msg("notify.lateArrive", { name: tech.name, customer: v.customer.name, code, time: timeKey(v.startsAt, tz) }), appointmentId: v.id });
      }
    }
  }
  return { day, items };
}

/** Sends the late alerts not sent yet today to the Admins (in-app). Called every 15 minutes by a scheduler. */
export async function runLateCheck(now: Date = new Date()) {
  const { day, items } = await lateItems(now);
  if (!items.length) return { day, sent: 0 };
  return prisma.$transaction(async (tx) => {
    await tx.alertSent.deleteMany({ where: { day: { lt: dbDate(addDaysToKey(day, -2)) } } });
    const already = new Set((await tx.alertSent.findMany({ where: { day: dbDate(day), key: { in: items.map((i) => i.key) } }, select: { key: true } })).map((a) => a.key));
    const fresh = items.filter((i) => !already.has(i.key));
    if (!fresh.length) return { day, sent: 0 };
    await tx.alertSent.createMany({ data: fresh.map((i) => ({ day: dbDate(day), key: i.key })), skipDuplicates: true });
    const to = await admins(tx);
    for (const i of fresh) await notifyUsers(tx, to, { appointmentId: i.appointmentId, type: "LATE", message: i.message });
    return { day, sent: fresh.length };
  }, TX_OPTIONS);
}

// ---------------------------------------------------------------------------------------------
// Attendance and points
// ---------------------------------------------------------------------------------------------

export type AttendanceRow = {
  technician: { id: string; name: string };
  days: number;
  avgIn: string | null;
  avgOut: string | null;
  lateDays: number;
  lateMinutes: number;
  earlyLeaves: number;
  leaveDays: number;
  sickDays: number;
  absences: number;
  absentDates: string[];
  visits: number;
  done: number;
  arrived: number;
  onTime: number;
  ratingAvg: number | null;
  gradeAvg: number | null;
  revisits: number;
  complaints: number;
  avgVisitMinutes: number | null;
  points: number;
};

const avgTime = (mins: number[]) => {
  if (!mins.length) return null;
  const m = Math.round(mins.reduce((a, b) => a + b, 0) / mins.length);
  return `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
};
const round1 = (n: number) => Math.round(n * 10) / 10;

/**
 * Attendance and points per technician for a month (YYYY-MM). Readers with attendance.view see
 * everyone; a technician sees their own row only.
 */
export async function attendance(user: CurrentUser, monthRaw: string | undefined, now: Date = new Date()): Promise<{ month: string; rows: AttendanceRow[] }> {
  const all = hasPermission(user, "attendance.view");
  if (!all && !hasPermission(user, "checkins.record")) throw new ForbiddenError();
  const tz = user.settings.timezone;
  const today = todayKey(tz, now);
  const month = /^\d{4}-(0[1-9]|1[0-2])$/.test(monthRaw ?? "") ? monthRaw! : today.slice(0, 7);
  const first = `${month}-01`;
  const last = addDaysToKey(addMonthsToKey(startOfMonthKey(first), 1), -1);
  const range = dayRangeUtc(first, last, tz);
  const techWhere: Prisma.UserWhereInput = all ? { role: "TECHNICIAN", OR: [{ isActive: true }, { checkIns: { some: { day: { gte: dbDate(first), lte: dbDate(last) } } } }] } : { id: user.id };
  const [techs, checkIns, leaves, visits, complaints] = await Promise.all([
    prisma.user.findMany({ where: techWhere, select: { id: true, name: true }, orderBy: { name: "asc" } }),
    prisma.checkIn.findMany({
      where: { day: { gte: dbDate(first), lte: dbDate(last) }, ...(all ? {} : { userId: user.id }) },
      select: { userId: true, kind: true, appointmentId: true, day: true, createdAt: true, lateMinutes: true, earlyMinutes: true },
      orderBy: { createdAt: "asc" },
    }),
    prisma.technicianLeave.findMany({
      where: { status: "APPROVED", startDate: { lte: dbDate(last) }, endDate: { gte: dbDate(first) }, ...(all ? {} : { userId: user.id }) },
      select: { userId: true, type: true, startDate: true, endDate: true },
    }),
    prisma.appointment.findMany({
      where: { startsAt: { gte: range.start, lt: range.end }, status: { kind: { notIn: ["CANCELLED", "POSTPONED"] } }, ...(all ? {} : { technicians: { some: { technicianId: user.id } } }) },
      select: { id: true, startsAt: true, customerRating: true, qualityGrade: true, status: { select: { kind: true } }, technicians: { select: { technicianId: true } } },
    }),
    prisma.complaint.findMany({ where: { createdAt: { gte: range.start, lt: range.end } }, select: { appointment: { select: { technicians: { select: { technicianId: true } } } } } }),
  ]);
  const closed = user.settings.closedWeekdays;
  const rows = techs.map((tech): AttendanceRow => {
    const mine = checkIns.filter((c) => c.userId === tech.id);
    const byDay = new Map<string, { in?: number; out?: number; any: boolean }>();
    let lateDays = 0;
    let lateMinutes = 0;
    let earlyLeaves = 0;
    for (const c of mine) {
      const k = keyOf(c.day);
      const d = byDay.get(k) ?? { any: false };
      d.any = true;
      if (c.kind === "COMPANY" && d.in === undefined) {
        d.in = minutesOf(timeKey(c.createdAt, tz));
        if (c.lateMinutes) {
          lateDays++;
          lateMinutes += c.lateMinutes;
        }
      }
      if (c.kind === "LEAVE") {
        d.out = minutesOf(timeKey(c.createdAt, tz));
        if (c.earlyMinutes) earlyLeaves++;
      }
      byDay.set(k, d);
    }
    let leaveDays = 0;
    let sickDays = 0;
    const absentDates = new Set<string>();
    const onLeave = new Set<string>();
    for (const l of leaves.filter((x) => x.userId === tech.id)) {
      for (let d = keyOf(l.startDate); d <= keyOf(l.endDate); d = addDaysToKey(d, 1)) {
        if (d < first || d > last || closed.includes(weekdayOfKey(d))) continue;
        onLeave.add(d);
        if (l.type === "SICK") sickDays++;
        else if (l.type === "ABSENCE") absentDates.add(d);
        else leaveDays++;
      }
    }
    const myVisits = visits.filter((v) => v.technicians.some((t) => t.technicianId === tech.id));
    // A past day with a visit in their name, no check-in at all and no approved leave counts as absent.
    for (const v of myVisits) {
      const d = dateKey(v.startsAt, tz);
      if (d < today && !byDay.get(d)?.any && !onLeave.has(d)) absentDates.add(d);
    }
    const arrivals = new Map(mine.filter((c) => c.kind === "ARRIVE" && c.appointmentId).map((c) => [c.appointmentId!, c.createdAt]));
    const dones = new Map(mine.filter((c) => c.kind === "DONE" && c.appointmentId).map((c) => [c.appointmentId!, c.createdAt]));
    let arrived = 0;
    let onTime = 0;
    const durations: number[] = [];
    for (const v of myVisits) {
      const at = arrivals.get(v.id);
      if (!at) continue;
      arrived++;
      if (at.getTime() <= v.startsAt.getTime() + 15 * 60_000) onTime++;
      const end = dones.get(v.id);
      if (end) {
        const m = Math.round((end.getTime() - at.getTime()) / 60_000);
        if (m > 0 && m < 12 * 60) durations.push(m);
      }
    }
    const ratings = myVisits.map((v) => v.customerRating).filter((r): r is number => r !== null);
    const grades = myVisits.map((v) => v.qualityGrade).filter((r): r is number => r !== null);
    const done = myVisits.filter((v) => v.status.kind === "COMPLETED").length;
    const revisits = myVisits.filter((v) => v.status.kind === "NEEDS_REVISIT").length;
    const complaintCount = complaints.filter((c) => c.appointment.technicians.some((t) => t.technicianId === tech.id)).length;
    const ins = [...byDay.values()].map((d) => d.in).filter((m): m is number => m !== undefined);
    const outs = [...byDay.values()].map((d) => d.out).filter((m): m is number => m !== undefined);
    const ratingAvg = ratings.length ? round1(ratings.reduce((a, b) => a + b, 0) / ratings.length) : null;
    const gradeAvg = grades.length ? round1(grades.reduce((a, b) => a + b, 0) / grades.length) : null;
    return {
      technician: tech,
      days: ins.length,
      avgIn: avgTime(ins),
      avgOut: avgTime(outs),
      lateDays,
      lateMinutes,
      earlyLeaves,
      leaveDays,
      sickDays,
      absences: absentDates.size,
      absentDates: [...absentDates].sort(),
      visits: myVisits.length,
      done,
      arrived,
      onTime,
      ratingAvg,
      gradeAvg,
      revisits,
      complaints: complaintCount,
      avgVisitMinutes: durations.length ? Math.round(durations.reduce((a, b) => a + b, 0) / durations.length) : null,
      points: monthlyPoints({ arrived, onTime, ratingAvg, gradeAvg, done, revisits, complaints: complaintCount, lateDays, absences: absentDates.size }),
    };
  });
  return { month, rows };
}
