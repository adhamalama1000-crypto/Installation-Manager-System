import { beforeEach, describe, expect, it } from "vitest";
import type { User } from "@prisma/client";
import { createAppointment, updateAppointment } from "@/server/services/appointments";
import { holdSlot, releaseHolds } from "@/server/services/booking-helpers";
import { DEFAULT_TIMEZONE } from "@/lib/constants";
import { addDaysToKey, todayKey } from "@/lib/time";
import { ValidationError } from "@/server/errors";
import { appointmentPayload, asCurrent, makeUser, prisma, resetDb, seedStatuses } from "../helpers";

/**
 * Holds and bookings of the same technician must never both win: whichever runs first, the other
 * is refused. They take the same per-technician lock (lockTechnicians), so they run one after the
 * other even when two people press at the same moment.
 */
const tomorrow = addDaysToKey(todayKey(DEFAULT_TIMEZONE), 1);
const ROUNDS = 12;

let sales: User, otherSales: User, tech: User;
beforeEach(async () => {
  await resetDb();
  await seedStatuses();
  sales = await makeUser("SALES", { name: "Sara Sales" });
  otherSales = await makeUser("SALES", { name: "Omar Sales" });
  tech = await makeUser("TECHNICIAN", { name: "Karim Tech" });
});

// One-hour slots from 08:00, so every round starts on a free technician.
const slot = (round: number) => ({ date: tomorrow, startTime: `${String(8 + round).padStart(2, "0")}:00`, durationMinutes: 60 });

describe("holds and bookings at the same moment", () => {
  it("never lets a hold and another person's booking of the same technician both succeed", async () => {
    for (let round = 0; round < ROUNDS; round++) {
      const s = slot(round);
      const [hold, booking] = await Promise.allSettled([
        holdSlot(asCurrent(sales), { ...s, technicianIds: [tech.id] }),
        createAppointment(asCurrent(otherSales), appointmentPayload({ ...s, technicianIds: [tech.id] })),
      ]);
      const held = hold.status === "fulfilled" && hold.value.ok;
      const booked = booking.status === "fulfilled";
      expect(held && booked, `round ${round}: both the hold and the booking went through`).toBe(false);
      expect(held || booked, `round ${round}: neither went through`).toBe(true);
      if (!booked) expect((booking as PromiseRejectedResult).reason).toBeInstanceOf(ValidationError);
      if (!held) expect(hold.status === "fulfilled" && !hold.value.ok && hold.value.reason).toMatch(/^holds\.booked/);
      // The next round must start clean for Sara (holdSlot replaces her own holds anyway).
      await prisma.slotHold.deleteMany({});
    }
  });

  it("gives a contested technician to exactly one of two people holding at the same moment", async () => {
    for (let round = 0; round < ROUNDS; round++) {
      const s = slot(round);
      const results = await Promise.all([
        holdSlot(asCurrent(sales), { ...s, technicianIds: [tech.id] }),
        holdSlot(asCurrent(otherSales), { ...s, technicianIds: [tech.id] }),
      ]);
      expect(results.filter((r) => r.ok), `round ${round}`).toHaveLength(1);
      expect(await prisma.slotHold.count({ where: { technicianId: tech.id } })).toBe(1);
      await prisma.slotHold.deleteMany({});
    }
  });

  it("never lets two people book the same technician over each other's hold at the same moment", async () => {
    for (let round = 0; round < ROUNDS; round++) {
      const s = slot(round);
      const results = await Promise.allSettled([
        createAppointment(asCurrent(sales), appointmentPayload({ ...s, technicianIds: [tech.id] })),
        createAppointment(asCurrent(otherSales), appointmentPayload({ ...s, technicianIds: [tech.id] })),
      ]);
      expect(results.filter((r) => r.status === "fulfilled"), `round ${round}`).toHaveLength(1);
    }
    const booked = await prisma.appointmentTechnician.count({ where: { technicianId: tech.id, blocksSchedule: true } });
    expect(booked).toBe(ROUNDS);
  });
});

describe("hold lifecycle", () => {
  it("is replaced when the technicians change, released by an empty choice, and refused for someone who is not an active technician", async () => {
    const other = await makeUser("TECHNICIAN", { name: "Other Tech" });
    await holdSlot(asCurrent(sales), { ...slot(0), technicianIds: [tech.id] });
    await holdSlot(asCurrent(sales), { ...slot(0), technicianIds: [other.id] });
    expect(await prisma.slotHold.findMany({ select: { technicianId: true } })).toEqual([{ technicianId: other.id }]);
    expect(await holdSlot(asCurrent(sales), { ...slot(0), technicianIds: [] })).toMatchObject({ ok: true, until: null });
    expect(await prisma.slotHold.count()).toBe(0);

    const inactive = await makeUser("TECHNICIAN", { isActive: false });
    expect(await holdSlot(asCurrent(sales), { ...slot(0), technicianIds: [tech.id, inactive.id] })).toMatchObject({ ok: false, reason: "holds.unknownTechnician" });
    expect(await holdSlot(asCurrent(sales), { ...slot(0), technicianIds: [otherSales.id] })).toMatchObject({ ok: false, reason: "holds.unknownTechnician" });
    expect(await prisma.slotHold.count()).toBe(0);
  });

  it("is released when the holder saves an edit, and expired holds are cleaned up on release", async () => {
    const appt = await createAppointment(asCurrent(sales), appointmentPayload({ ...slot(0) }));
    await holdSlot(asCurrent(sales), { ...slot(2), technicianIds: [tech.id], excludeAppointmentId: appt.id });
    await updateAppointment(asCurrent(sales), appt.id, appointmentPayload({ ...slot(2), technicianIds: [tech.id], version: appt.version }));
    expect(await prisma.slotHold.count({ where: { userId: sales.id } })).toBe(0);

    // Omar's hold ran out long ago; Sara leaving her form also clears it.
    await holdSlot(asCurrent(otherSales), { ...slot(5), technicianIds: [tech.id] });
    await prisma.slotHold.updateMany({ data: { expiresAt: new Date(Date.now() - 60_000), createdAt: new Date(Date.now() - 20 * 60_000) } });
    await releaseHolds(asCurrent(sales));
    expect(await prisma.slotHold.count()).toBe(0);
  });
});

