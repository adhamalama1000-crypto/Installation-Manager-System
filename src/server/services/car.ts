import "server-only";
import { z } from "zod";
import type { CheckInKind, Prisma } from "@prisma/client";
import { msg } from "@/i18n/translator";
import { appointmentCode } from "@/lib/constants";
import { distanceM, etaMinutes, minutesOf, type Geo } from "@/lib/field";
import { areaGeo } from "@/lib/areas";
import { resolveLocationLink } from "@/lib/maps";
import { addDaysToKey, dateKey, dayRangeUtc, isValidDateString, timeKey, todayKey, zonedToUtc } from "@/lib/time";
import type { CheckInDTO } from "@/lib/types";
import { fieldErrorsFromZod, geoSchema } from "@/lib/validation";
import { prisma } from "../db";
import { appointmentScope, assertCan, hasPermission } from "../access";
import type { CurrentUser } from "../auth/session";
import { NotFoundError, ValidationError } from "../errors";
import { recordAudit } from "./audit";
import { insertCheckIn } from "./field";
import { getSettings } from "./settings";

/**
 * The company car (Aura routeStops_, routeWarnings_, api_route, api_carCheckin, api_routeOrder,
 * api_carWarn, carLive_): the day's visits the car serves, in order (the stops the head of
 * installations ordered by hand first, then each period from the nearest stop on), warnings when a
 * period has too many drops or drops far apart, and the driver's check-ins.
 */

const num = (d: Prisma.Decimal | null) => (d === null ? null : d.toNumber());

/** Aura's periods: 11:30-1:30, 2:30-4:30, 5:30-7:30 and after hours, from a visit's start time. */
export function carSlot(startsAt: Date, tz: string): 1 | 2 | 3 | 4 {
  const m = minutesOf(timeKey(startsAt, tz));
  return m < 14 * 60 ? 1 : m < 17 * 60 ? 2 : m < 20 * 60 ? 3 : 4;
}

/** More drops than this in one period are too many for one car; drops this far apart cannot share it. */
export const MAX_DROPS_PER_SLOT = 3;
export const FAR_APART_M = 20_000;

type Stop = {
  id: string;
  number: number;
  startsAt: Date;
  slot: 1 | 2 | 3 | 4;
  carSeq: number | null;
  geo: Geo | null;
  area: string | null;
  customerName: string;
};

/** Manual order first, then each period by nearest neighbour from the company (or the last stop). */
export function orderStops<T extends Stop>(stops: T[], company: Geo | null): T[] {
  const manual = stops.filter((s) => s.carSeq !== null).sort((a, b) => a.carSeq! - b.carSeq! || a.slot - b.slot || a.startsAt.getTime() - b.startsAt.getTime());
  const auto = stops.filter((s) => s.carSeq === null);
  const out = [...manual];
  let cur = out.length && out[out.length - 1]!.geo ? out[out.length - 1]!.geo : company;
  for (const slot of [1, 2, 3, 4] as const) {
    const pool = auto.filter((s) => s.slot === slot).sort((a, b) => a.startsAt.getTime() - b.startsAt.getTime() || a.number - b.number);
    while (pool.length) {
      let best = 0;
      let bestD = Infinity;
      pool.forEach((s, i) => {
        const d = cur && s.geo ? distanceM(cur, s.geo) : 1e9 + i;
        if (d < bestD) {
          bestD = d;
          best = i;
        }
      });
      const pick = pool.splice(best, 1)[0]!;
      out.push(pick);
      if (pick.geo) cur = pick.geo;
    }
  }
  return out;
}

export type RouteWarning = { slot: number; message: string };

export function routeWarnings(stops: Stop[]): RouteWarning[] {
  const out: RouteWarning[] = [];
  for (const slot of [1, 2, 3, 4] as const) {
    const g = stops.filter((s) => s.slot === slot);
    if (g.length > MAX_DROPS_PER_SLOT) out.push({ slot, message: msg("car.warnMany", { count: g.length, slot: `@car.slot.${slot}` }) });
    for (let i = 0; i < g.length; i++) {
      for (let j = i + 1; j < g.length; j++) {
        const a = g[i]!;
        const b = g[j]!;
        if (!a.geo || !b.geo) continue;
        const d = distanceM(a.geo, b.geo);
        if (d >= FAR_APART_M) out.push({ slot, message: msg("car.warnFar", { a: a.area || a.customerName, b: b.area || b.customerName, km: Math.round(d / 1000) }) });
      }
    }
  }
  return out;
}

const visitSelect = {
  id: true,
  number: true,
  startsAt: true,
  carSeq: true,
  status: { select: { kind: true } },
  customer: { select: { name: true, phone: true } },
  location: { select: { area: true, streetAddress: true, building: true, mapUrl: true, latitude: true, longitude: true } },
  technicians: { select: { technician: { select: { id: true, name: true } } } },
} satisfies Prisma.AppointmentSelect;
type VisitRow = Prisma.AppointmentGetPayload<{ select: typeof visitSelect }>;

async function dayStops(day: string, tz: string) {
  const range = dayRangeUtc(day, day, tz);
  const rows = await prisma.appointment.findMany({
    where: { needsCar: true, startsAt: { gte: range.start, lt: range.end }, status: { kind: { notIn: ["CANCELLED", "POSTPONED"] } } },
    select: visitSelect,
  });
  return rows.map((r) => {
    const lat = num(r.location.latitude);
    const lng = num(r.location.longitude);
    // Without a pin, the area's centre is close enough to order the stops (Aura clientGeo_).
    const geo = lat !== null && lng !== null ? { lat, lng } : areaGeo(r.location.area);
    return { row: r, id: r.id, number: r.number, startsAt: r.startsAt, slot: carSlot(r.startsAt, tz), carSeq: r.carSeq, geo, area: r.location.area, customerName: r.customer.name };
  });
}

export type RouteStop = {
  seq: number;
  id: string;
  code: string;
  customerName: string;
  customerPhone?: string;
  area: string | null;
  address: string | null;
  mapLink: string | null;
  startsAt: string;
  slot: number;
  technicians: { id: string; name: string }[];
  statusKind: string;
  /** The team's latest check-in on this visit. */
  teamStage: { kind: string; at: string } | null;
  drop: string | null;
  pick: string | null;
  finished: boolean;
  readyForPick: boolean;
  manual: boolean;
};

export type RouteView = {
  day: string;
  stops: RouteStop[];
  warnings: RouteWarning[];
  drivers: { id: string; name: string; phone: string | null }[];
  go: string | null;
  back: string | null;
  canReorder: boolean;
  canCheckIn: boolean;
};

export async function getRoute(user: CurrentUser, dayRaw?: string, now: Date = new Date()): Promise<RouteView> {
  assertCan(user, "route.view");
  const settings = user.settings;
  const tz = settings.timezone;
  const day = dayRaw && isValidDateString(dayRaw) ? dayRaw : todayKey(tz, now);
  const company = settings.companyLatitude !== null && settings.companyLongitude !== null ? { lat: settings.companyLatitude, lng: settings.companyLongitude } : null;
  const [stops, drivers, checkIns] = await Promise.all([
    dayStops(day, tz),
    prisma.user.findMany({ where: { role: "DRIVER", isActive: true }, select: { id: true, name: true, phone: true }, orderBy: { name: "asc" } }),
    prisma.checkIn.findMany({ where: { day: new Date(`${day}T00:00:00.000Z`) }, select: { userId: true, kind: true, appointmentId: true, createdAt: true, user: { select: { role: true } } }, orderBy: { createdAt: "asc" } }),
  ]);
  const ordered = orderStops(stops, company);
  // The car's check-ins: the reader's own when they drive, otherwise every driver's.
  const isCar = (c: (typeof checkIns)[number]) => (user.role === "DRIVER" ? c.userId === user.id : c.user.role === "DRIVER");
  const car = checkIns.filter(isCar);
  const team = checkIns.filter((c) => !c.kind.startsWith("CAR_"));
  const canContact = hasPermission(user, "customers.contact");
  const canLocation = hasPermission(user, "location.view");
  const out: RouteStop[] = ordered.map((s, i) => {
    const r: VisitRow = s.row;
    const last = [...team].reverse().find((c) => c.appointmentId === s.id) ?? null;
    const drop = car.find((c) => c.kind === "CAR_DROP" && c.appointmentId === s.id);
    const pick = car.find((c) => c.kind === "CAR_PICK" && c.appointmentId === s.id);
    const finished = ["COMPLETED", "NEEDS_REVISIT", "UNABLE_TO_COMPLETE"].includes(r.status.kind) || last?.kind === "DONE" || last?.kind === "PROBLEM";
    return {
      seq: i + 1,
      id: r.id,
      code: appointmentCode(r.number),
      customerName: r.customer.name,
      ...(canContact ? { customerPhone: r.customer.phone } : {}),
      area: canLocation ? r.location.area : null,
      address: canLocation ? [r.location.streetAddress, r.location.building].filter(Boolean).join(", ") || null : null,
      mapLink: canLocation ? resolveLocationLink({ mapUrl: r.location.mapUrl, latitude: num(r.location.latitude), longitude: num(r.location.longitude) }) : null,
      startsAt: r.startsAt.toISOString(),
      slot: s.slot,
      technicians: r.technicians.map((t) => t.technician),
      statusKind: r.status.kind,
      teamStage: last ? { kind: last.kind, at: last.createdAt.toISOString() } : null,
      drop: drop?.createdAt.toISOString() ?? null,
      pick: pick?.createdAt.toISOString() ?? null,
      finished,
      readyForPick: finished && !pick,
      manual: s.carSeq !== null,
    };
  });
  return {
    day,
    stops: out,
    warnings: routeWarnings(ordered),
    drivers,
    go: car.find((c) => c.kind === "CAR_GO")?.createdAt.toISOString() ?? null,
    back: car.find((c) => c.kind === "CAR_BACK")?.createdAt.toISOString() ?? null,
    canReorder: hasPermission(user, "route.manage"),
    canCheckIn: hasPermission(user, "car.checkin") && day === todayKey(tz, now),
  };
}

const orderSchema = z.object({ day: z.string().refine(isValidDateString), ids: z.array(z.string().max(64)).max(100) });

/** Saves the stop order the head of installations chose (Aura api_routeOrder). */
export async function reorderRoute(user: CurrentUser, raw: unknown) {
  assertCan(user, "route.manage");
  const parsed = orderSchema.safeParse(raw);
  if (!parsed.success) throw new ValidationError(fieldErrorsFromZod(parsed.error));
  const { day, ids } = parsed.data;
  const tz = user.settings.timezone;
  const stops = await dayStops(day, tz);
  if (new Set(ids).size !== ids.length || ids.some((id) => !stops.some((s) => s.id === id))) throw new ValidationError({ ids: msg("validation.invalid") });
  await prisma.$transaction(async (tx) => {
    for (const s of stops) {
      const i = ids.indexOf(s.id);
      const seq = i >= 0 ? i + 1 : null;
      if (seq === s.carSeq) continue;
      await tx.appointment.update({ where: { id: s.id }, data: { carSeq: seq } });
      await recordAudit(tx, {
        entityType: "APPOINTMENT",
        entityId: s.id,
        appointmentId: s.id,
        action: "CAR_ORDER",
        summary: seq ? msg("audit.carOrder", { code: appointmentCode(s.number), seq }) : msg("audit.carOrderCleared", { code: appointmentCode(s.number) }),
        changes: { carSeq: { from: s.carSeq, to: seq } },
        actorId: user.id,
      });
    }
  });
  return getRoute(user, day);
}

const carCheckInSchema = z.object({
  kind: z.enum(["CAR_GO", "CAR_DROP", "CAR_PICK", "CAR_BACK"], { error: msg("validation.invalid") }),
  appointmentId: z.string().max(64).optional().nullable(),
  geo: geoSchema.optional().nullable(),
});

/** The driver's check-ins (Aura api_carCheckin): left, dropped a team, picked a team up, back. */
export async function carCheckIn(user: CurrentUser, raw: unknown, now: Date = new Date()): Promise<CheckInDTO> {
  assertCan(user, "car.checkin");
  const parsed = carCheckInSchema.safeParse(raw);
  if (!parsed.success) throw new ValidationError(fieldErrorsFromZod(parsed.error));
  const { kind, geo } = parsed.data;
  const settings = await getSettings();
  const day = new Date(`${todayKey(settings.timezone, now)}T00:00:00.000Z`);
  const result = await prisma.$transaction(async (tx) => {
    let visit = null;
    if (kind === "CAR_DROP" || kind === "CAR_PICK") {
      const id = parsed.data.appointmentId;
      if (!id) throw new ValidationError({ appointmentId: msg("validation.invalid") });
      const a = await tx.appointment.findFirst({
        where: { AND: [{ id }, appointmentScope(user)] },
        select: { id: true, number: true, createdById: true, needsCar: true, customer: { select: { name: true } }, location: { select: { latitude: true, longitude: true } } },
      });
      if (!a) throw new NotFoundError("errors.appointmentNotFound");
      if (!a.needsCar) throw new ValidationError({ appointmentId: msg("car.errors.notCar") }, msg("car.errors.notCar"));
      visit = { id: a.id, number: a.number, createdById: a.createdById, customerName: a.customer.name, latitude: num(a.location.latitude), longitude: num(a.location.longitude) };
    } else if (kind === "CAR_BACK" && !(await tx.checkIn.findFirst({ where: { userId: user.id, kind: "CAR_GO", day }, select: { id: true } }))) {
      throw new ValidationError({ kind: msg("car.errors.goFirst") }, msg("car.errors.goFirst"));
    }
    return insertCheckIn(tx, user, kind as CheckInKind, visit, geo ?? null, settings, {}, now);
  });
  const r = result.row;
  return {
    id: r.id,
    kind: r.kind,
    at: r.createdAt.toISOString(),
    user: { id: user.id, name: user.name },
    appointmentId: r.appointmentId,
    hasLocation: r.latitude !== null,
    distanceM: r.distanceM,
    etaAt: null,
    lateMinutes: r.lateMinutes,
    earlyMinutes: r.earlyMinutes,
    far: r.far,
    reason: null,
    note: null,
    ...(result.duplicate ? { duplicate: true } : {}),
  };
}

/**
 * A warning for the booking form when the car is asked for (Aura api_carWarn): other drops in the
 * same period far from this site, too many drops, or just how many there are.
 */
export async function carWarning(user: CurrentUser, q: { date?: string | null; time?: string | null; lat?: string | null; lng?: string | null; area?: string | null; exclude?: string | null }) {
  assertCan(user, "appointments.manage");
  if (!q.date || !isValidDateString(q.date) || !q.time || !/^\d{2}:\d{2}$/.test(q.time)) return { message: null };
  const tz = user.settings.timezone;
  const slot = carSlot(zonedToUtc(q.date, q.time, tz), tz);
  const lat = Number(q.lat);
  const lng = Number(q.lng);
  const here = q.lat && q.lng && Number.isFinite(lat) && Number.isFinite(lng) ? { lat, lng } : areaGeo(q.area);
  const same = (await dayStops(q.date, tz)).filter((s) => s.slot === slot && s.id !== q.exclude);
  if (!same.length) return { message: null };
  const far = here ? same.filter((s) => s.geo && distanceM(here, s.geo) >= FAR_APART_M) : [];
  if (far.length) {
    return { level: "danger", message: msg("car.bookFar", { places: far.map((s) => s.area || s.customerName).join(" · "), km: Math.round(distanceM(here!, far[0]!.geo!) / 1000) }) };
  }
  if (same.length >= MAX_DROPS_PER_SLOT) return { level: "warning", message: msg("car.bookMany", { count: same.length }) };
  return { level: "info", message: msg("car.bookOthers", { count: same.length, places: same.map((s) => s.area || s.customerName).join(" · ") }) };
}

export type CarLive = {
  driver: { id: string; name: string; phone: string | null };
  state: "free" | "notYet" | "onWay" | "done" | "back";
  tone: "red" | "yellow" | "green" | "grey";
  total: number;
  dropped: number;
  next: { customerName: string; area: string | null; startsAt: string } | null;
  etaAt: string | null;
  since: string | null;
};

/** The car on the live board (Aura carLive_). Null when there is no driver. */
export async function carLive(user: CurrentUser, now: Date = new Date()): Promise<CarLive | null> {
  const tz = user.settings.timezone;
  const day = todayKey(tz, now);
  const driver = await prisma.user.findFirst({ where: { role: "DRIVER", isActive: true }, select: { id: true, name: true, phone: true }, orderBy: { name: "asc" } });
  if (!driver) return null;
  const company = user.settings.companyLatitude !== null && user.settings.companyLongitude !== null ? { lat: user.settings.companyLatitude, lng: user.settings.companyLongitude } : null;
  const [stops, mine, pos] = await Promise.all([
    dayStops(day, tz),
    prisma.checkIn.findMany({ where: { userId: driver.id, day: new Date(`${day}T00:00:00.000Z`) }, orderBy: { createdAt: "asc" } }),
    prisma.technicianPosition.findUnique({ where: { userId: driver.id } }),
  ]);
  const ordered = orderStops(stops, company);
  const go = mine.find((c) => c.kind === "CAR_GO");
  const back = mine.find((c) => c.kind === "CAR_BACK");
  const dropped = new Set(mine.filter((c) => c.kind === "CAR_DROP").map((c) => c.appointmentId));
  const next = ordered.find((s) => !dropped.has(s.id)) ?? null;
  const hhmm = timeKey(now, tz);
  let state: CarLive["state"] = "free";
  let tone: CarLive["tone"] = "grey";
  let etaAt: string | null = null;
  let since: string | null = null;
  if (ordered.length) {
    if (back) {
      state = "back";
      tone = "green";
      since = back.createdAt.toISOString();
    } else if (!go) {
      state = "notYet";
      tone = next && now.getTime() > next.startsAt.getTime() - 45 * 60_000 ? "red" : hhmm >= "10:30" ? "yellow" : "grey";
    } else if (next) {
      state = "onWay";
      since = go.createdAt.toISOString();
      const fresh = pos && dateKey(pos.at, tz) === day && now.getTime() - pos.at.getTime() <= 30 * 60_000;
      if (fresh && next.geo) etaAt = new Date(now.getTime() + etaMinutes({ lat: pos.latitude.toNumber(), lng: pos.longitude.toNumber() }, next.geo, Number(hhmm.slice(0, 2))) * 60_000).toISOString();
      tone = etaAt && Date.parse(etaAt) > next.startsAt.getTime() + 15 * 60_000 ? "red" : now.getTime() > next.startsAt.getTime() ? "yellow" : "green";
    } else {
      state = "done";
      tone = "green";
    }
  }
  return {
    driver,
    state,
    tone,
    total: ordered.length,
    dropped: dropped.size,
    next: next ? { customerName: next.customerName, area: next.area, startsAt: next.startsAt.toISOString() } : null,
    etaAt,
    since,
  };
}

/** Today and the next days, for the route page's day switcher. */
export function routeDays(tz: string, now: Date = new Date()) {
  const today = todayKey(tz, now);
  return [addDaysToKey(today, -1), today, addDaysToKey(today, 1), addDaysToKey(today, 2)];
}
