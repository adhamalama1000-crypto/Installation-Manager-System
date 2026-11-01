import "server-only";
import { z } from "zod";
import type { ProductCategory, TechnicianSpecialty } from "@prisma/client";
import { msg } from "@/i18n/translator";
import { areaGeo } from "@/lib/areas";
import { distanceM, type Geo } from "@/lib/field";
import { computeEnd, dateKey, dayRangeUtc, isValidDateString, TIME_RE, timeKey, zonedToUtc } from "@/lib/time";
import { fieldErrorsFromZod } from "@/lib/validation";
import { prisma, type Db } from "../db";
import { assertCan } from "../access";
import type { CurrentUser } from "../auth/session";
import { ValidationError } from "../errors";
import { findTechnicianConflicts, lockTechnicians } from "./scheduling";
import { carSlot } from "./car";

/**
 * Booking helpers from Aura: 10-minute holds on a technician's time while Sales is on the phone
 * (api_hold), and the "best technician" suggestion by specialty, how full their day is and how
 * close their neighbouring visit is (api_free).
 */

export const HOLD_MINUTES = 10;

/** Holds by other people that overlap a time range, per technician (expired ones are ignored). */
export async function activeHolds(db: Db, technicianIds: string[], startsAt: Date, endsAt: Date, excludeUserId: string, now: Date = new Date()) {
  if (!technicianIds.length) return [];
  return db.slotHold.findMany({
    where: { technicianId: { in: technicianIds }, userId: { not: excludeUserId }, expiresAt: { gt: now }, startsAt: { lt: endsAt }, endsAt: { gt: startsAt } },
    select: { technicianId: true, expiresAt: true, user: { select: { name: true } }, technician: { select: { name: true } } },
  });
}

/** Refuses a booking on a technician someone else is holding (Admins may book over a hold, as Aura's managers could). */
export async function assertNotHeld(db: Db, user: CurrentUser, technicianIds: string[], startsAt: Date, endsAt: Date) {
  if (user.role === "ADMIN") return;
  const held = await activeHolds(db, technicianIds, startsAt, endsAt, user.id);
  if (!held.length) return;
  const h = held[0]!;
  const text = msg("holds.heldByOther", { technician: h.technician.name, name: h.user.name, until: timeKey(h.expiresAt, user.settings.timezone) });
  throw new ValidationError({ technicianIds: text }, text);
}

/**
 * The holder's own holds end when they book or leave the form. Expired holds of anyone are removed
 * at the same time; they never block anything, this only keeps the table small.
 */
export async function releaseOwnHolds(db: Db, userId: string, now: Date = new Date()) {
  await db.slotHold.deleteMany({ where: { OR: [{ userId }, { expiresAt: { lte: now } }] } });
}

const holdSchema = z.object({
  date: z.string().refine(isValidDateString, msg("validation.date")),
  startTime: z.string().regex(TIME_RE, msg("validation.time")),
  durationMinutes: z.coerce.number().int().min(15).max(1440),
  technicianIds: z.array(z.string().max(64)).max(20),
  excludeAppointmentId: z.string().max(64).optional().nullable(),
});

/** Holds the chosen technicians for the slot for 10 minutes, replacing the reader's earlier holds. */
export async function holdSlot(user: CurrentUser, raw: unknown, now: Date = new Date()) {
  assertCan(user, "appointments.manage");
  const parsed = holdSchema.safeParse(raw);
  if (!parsed.success) throw new ValidationError(fieldErrorsFromZod(parsed.error));
  const { date, startTime, durationMinutes, technicianIds } = parsed.data;
  const tz = user.settings.timezone;
  const startsAt = zonedToUtc(date, startTime, tz);
  const endsAt = computeEnd(startsAt, durationMinutes);
  const ids = [...new Set(technicianIds)];
  return prisma.$transaction(async (tx) => {
    // The same per-technician lock as bookings and leave (lockTechnicians): a hold and a booking of
    // the same technician run one after the other, so they can never both go through.
    await lockTechnicians(tx, ids);
    await releaseOwnHolds(tx, user.id, now);
    if (!ids.length) return { ok: true as const, until: null, technicianIds: [] as string[] };
    const active = await tx.user.count({ where: { id: { in: ids }, role: "TECHNICIAN", isActive: true } });
    if (active !== ids.length) return { ok: false as const, reason: msg("holds.unknownTechnician") };
    const held = await activeHolds(tx, ids, startsAt, endsAt, user.id, now);
    if (held.length) {
      return { ok: false as const, reason: msg("holds.heldByOther", { technician: held[0]!.technician.name, name: held[0]!.user.name, until: timeKey(held[0]!.expiresAt, tz) }) };
    }
    const booked = await findTechnicianConflicts(tx, { technicianIds: ids, startsAt, endsAt, excludeAppointmentId: parsed.data.excludeAppointmentId ?? undefined, bufferMinutes: user.settings.travelBufferMinutes });
    if (booked.length) return { ok: false as const, reason: msg("holds.booked", { technician: booked[0]!.technicianName }) };
    const expiresAt = new Date(now.getTime() + HOLD_MINUTES * 60_000);
    await tx.slotHold.createMany({ data: ids.map((technicianId) => ({ userId: user.id, technicianId, startsAt, endsAt, expiresAt, createdAt: now })) });
    return { ok: true as const, until: expiresAt.toISOString(), technicianIds: ids };
  });
}

export async function releaseHolds(user: CurrentUser) {
  assertCan(user, "appointments.manage");
  await releaseOwnHolds(prisma, user.id);
  return { ok: true };
}

/** A lock visit suits a lock technician, a smart-home visit a smart-home one; other categories suit everyone (Aura specFits_). */
export function specialtyFits(specialty: TechnicianSpecialty | null, category: ProductCategory | null | undefined) {
  if (!specialty || specialty === "BOTH" || !category) return true;
  if (category === "SMART_LOCK") return specialty === "LOCK";
  if (category === "SMART_HOME") return specialty === "SMART_HOME";
  return true;
}

export type Suggestion = { specialty: TechnicianSpecialty | null; fits: boolean; heldBy: { name: string; until: string } | null; score: number | null; suggested: boolean; dayVisits: number };

/**
 * Aura's suggestion score (lower is better) for technicians who are free, not held and suit the
 * visit: 8 per visit already that day; with a visit in the period before or after, -15 when it is
 * under 8 km from this site and +40 when it is over 20 km away. The two best are suggested.
 */
export async function suggestTechnicians(
  user: CurrentUser,
  q: { startsAt: Date; endsAt: Date; category?: ProductCategory | null; here: Geo | null; excludeAppointmentId?: string | null; available: Record<string, boolean> },
  now: Date = new Date(),
): Promise<Record<string, Suggestion>> {
  const tz = user.settings.timezone;
  const dayKey = dateKey(q.startsAt, tz);
  const day = dayRangeUtc(dayKey, dayKey, tz);
  const ids = Object.keys(q.available);
  const [techs, holds, visits] = await Promise.all([
    prisma.user.findMany({ where: { id: { in: ids } }, select: { id: true, specialty: true } }),
    activeHolds(prisma, ids, q.startsAt, q.endsAt, user.id, now),
    prisma.appointmentTechnician.findMany({
      where: {
        technicianId: { in: ids },
        blocksSchedule: true,
        startsAt: { gte: day.start, lt: day.end },
        ...(q.excludeAppointmentId ? { appointmentId: { not: q.excludeAppointmentId } } : {}),
      },
      select: { technicianId: true, startsAt: true, appointment: { select: { location: { select: { latitude: true, longitude: true, area: true } } } } },
    }),
  ]);
  const slot = carSlot(q.startsAt, tz);
  const out: Record<string, Suggestion> = {};
  for (const t of techs) {
    const hold = holds.find((h) => h.technicianId === t.id);
    const fits = specialtyFits(t.specialty, q.category);
    const mine = visits.filter((v) => v.technicianId === t.id);
    let score: number | null = null;
    if (q.available[t.id] && !hold && fits) {
      score = mine.length * 8;
      let near: number | null = null;
      for (const v of mine) {
        const loc = v.appointment.location;
        const there = loc.latitude !== null && loc.longitude !== null ? { lat: loc.latitude.toNumber(), lng: loc.longitude.toNumber() } : areaGeo(loc.area);
        if (Math.abs(carSlot(v.startsAt, tz) - slot) !== 1 || !q.here || !there) continue;
        const km = distanceM(q.here, there) / 1000;
        near = near === null ? km : Math.min(near, km);
      }
      if (near !== null) score += near > 20 ? 40 : near < 8 ? -15 : 0;
    }
    out[t.id] = {
      specialty: t.specialty,
      fits,
      heldBy: hold ? { name: hold.user.name, until: hold.expiresAt.toISOString() } : null,
      score,
      suggested: false,
      dayVisits: mine.length,
    };
  }
  Object.entries(out)
    .filter(([, s]) => s.score !== null)
    .sort((a, b) => a[1].score! - b[1].score!)
    .slice(0, 2)
    .forEach(([, s]) => (s.suggested = true));
  return out;
}

/** Aura: only managers may book on a past date. */
export function canBookInPast(user: CurrentUser) {
  return user.role === "ADMIN";
}
