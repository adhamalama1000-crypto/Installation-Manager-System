import "server-only";
import { msg } from "@/i18n/translate";
import { SLOT_HOLD_MINUTES } from "@/lib/constants";
import { computeEnd, zonedToUtc } from "@/lib/time";
import { fieldErrorsFromZod, holdSchema } from "@/lib/validation";
import { prisma, type Db, type Tx } from "../db";
import { assertCan } from "../access";
import type { CurrentUser } from "../auth/session";
import { ValidationError } from "../errors";
import { findTechnicianConflicts, lockTechnicians } from "./scheduling";
import { getSettings } from "./settings";

/**
 * Slot holds (Aura: حجز مؤقت): while Sales is on the phone with a customer, the chosen technicians'
 * time is reserved for a few minutes so a colleague cannot book it at the same moment. Holds are
 * taken under the same per-technician lock as bookings, never block their owner, and simply stop
 * counting once they expire.
 */

export type HoldInfo = { technicianId: string; technicianName: string; heldByName: string; expiresAt: string };

/** Unexpired holds of other users on these technicians that overlap [startsAt, endsAt). */
export async function holdsByOthers(db: Db, technicianIds: string[], startsAt: Date, endsAt: Date, userId: string, now = new Date()): Promise<HoldInfo[]> {
  if (!technicianIds.length) return [];
  const rows = await db.slotHold.findMany({
    where: {
      technicianId: { in: technicianIds },
      heldById: { not: userId },
      expiresAt: { gt: now },
      startsAt: { lt: endsAt },
      endsAt: { gt: startsAt },
    },
    select: { technicianId: true, expiresAt: true, technician: { select: { name: true } }, heldBy: { select: { name: true } } },
    orderBy: { expiresAt: "desc" },
  });
  return rows.map((r) => ({ technicianId: r.technicianId, technicianName: r.technician.name, heldByName: r.heldBy.name, expiresAt: r.expiresAt.toISOString() }));
}

/** Refuses a booking on a slot someone else is holding. Call after `lockTechnicians`. */
export async function assertNotHeld(tx: Tx, technicianIds: string[], startsAt: Date, endsAt: Date, userId: string, tz: string, now = new Date()) {
  const [held] = await holdsByOthers(tx, technicianIds, startsAt, endsAt, userId, now);
  if (held) throw new ValidationError({ technicianIds: heldMessage(held, tz) });
}

function heldMessage(h: HoldInfo, tz: string) {
  return msg("e.slotHeld", { name: h.technicianName, by: h.heldByName, until: { d: h.expiresAt, tz, s: "time" } });
}

/** Drops the user's holds (after booking, or when the form is closed). */
export async function releaseHolds(db: Db, userId: string) {
  await db.slotHold.deleteMany({ where: { heldById: userId } });
}

/**
 * Replaces the user's holds with one for these technicians and this slot. An empty technician
 * list just releases. Fails when another user holds the slot or a technician is already booked.
 */
export async function holdSlot(user: CurrentUser, raw: unknown, now = new Date()): Promise<{ technicianIds: string[]; expiresAt: string | null }> {
  assertCan(user, "appointments.manage");
  const parsed = holdSchema.safeParse(raw);
  if (!parsed.success) throw new ValidationError(fieldErrorsFromZod(parsed.error));
  const { date, startTime, durationMinutes } = parsed.data;
  const ids = [...new Set(parsed.data.technicianIds)];
  const settings = await getSettings();
  const tz = settings.timezone;
  const startsAt = zonedToUtc(date, startTime, tz);
  const endsAt = computeEnd(startsAt, durationMinutes);
  return prisma.$transaction(async (tx) => {
    await lockTechnicians(tx, ids);
    await tx.slotHold.deleteMany({ where: { OR: [{ heldById: user.id }, { expiresAt: { lte: now } }] } });
    if (!ids.length) return { technicianIds: [], expiresAt: null };
    const valid = await tx.user.count({ where: { id: { in: ids }, role: "TECHNICIAN", isActive: true } });
    if (valid !== ids.length) throw new ValidationError({ technicianIds: msg("e.technicianMissing") });
    const [held] = await holdsByOthers(tx, ids, startsAt, endsAt, user.id, now);
    if (held) throw new ValidationError({ technicianIds: heldMessage(held, tz) });
    const [booked] = await findTechnicianConflicts(tx, { technicianIds: ids, startsAt, endsAt, bufferMinutes: settings.travelBufferMinutes });
    if (booked) throw new ValidationError({ technicianIds: msg("e.holdBooked", { name: booked.technicianName }) });
    const expiresAt = new Date(now.getTime() + SLOT_HOLD_MINUTES * 60_000);
    await tx.slotHold.createMany({ data: ids.map((technicianId) => ({ technicianId, heldById: user.id, startsAt, endsAt, expiresAt })) });
    return { technicianIds: ids, expiresAt: expiresAt.toISOString() };
  });
}
