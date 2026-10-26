import { beforeEach, describe, expect, it } from "vitest";
import type { User } from "@prisma/client";
import { createAppointment, getAppointment, getAppointmentHistory, updateAppointment } from "@/server/services/appointments";
import { dashboardSummary } from "@/server/services/dashboard";
import { dayPlan } from "@/server/services/day-plan";
import { holdSlot } from "@/server/services/holds";
import { technicianAvailability } from "@/server/services/scheduling";
import { createUser, updateUser } from "@/server/services/users";
import { ValidationError } from "@/server/errors";
import { addDaysToKey, todayKey, zonedToUtc } from "@/lib/time";
import { DEFAULT_TIMEZONE } from "@/lib/constants";
import { appointmentPayload, asCurrent, makeUser, prisma, resetDb, seedStatuses } from "../helpers";

let admin: User, sales: User, otherSales: User, lockTech: User, smartTech: User;

beforeEach(async () => {
  await resetDb();
  await seedStatuses();
  admin = await makeUser("ADMIN");
  sales = await makeUser("SALES");
  otherSales = await makeUser("SALES");
  lockTech = await makeUser("TECHNICIAN", { name: "Lock Tech" });
  smartTech = await makeUser("TECHNICIAN", { name: "Smart Tech" });
  await prisma.user.update({ where: { id: lockTech.id }, data: { specialty: "LOCK" } });
  await prisma.user.update({ where: { id: smartTech.id }, data: { specialty: "SMART_HOME" } });
});

async function fieldErrors(p: Promise<unknown>) {
  const e = await p.then(
    () => null,
    (err: unknown) => err,
  );
  expect(e).toBeInstanceOf(ValidationError);
  return (e as ValidationError).fieldErrors;
}

describe("bookings in the past", () => {
  const yesterday = () => addDaysToKey(todayKey(DEFAULT_TIMEZONE), -1);

  it("refuses a past date to Sales but lets an Admin record a past visit", async () => {
    const errors = await fieldErrors(createAppointment(asCurrent(sales), appointmentPayload({ date: yesterday() })));
    expect(errors.date).toMatch(/has passed/);
    const a = await createAppointment(asCurrent(admin), appointmentPayload({ date: yesterday() }));
    expect(a.code).toMatch(/^APT-/);
  });

  it("lets Sales edit a booking that is already in the past, but not move one onto a past day", async () => {
    const past = await createAppointment(asCurrent(admin), appointmentPayload({ date: yesterday(), salesUserId: sales.id }));
    const edited = await updateAppointment(asCurrent(sales), past.id, appointmentPayload({ date: yesterday(), brand: "Philips", version: past.version }));
    expect(edited.brand).toBe("Philips");

    const future = await createAppointment(asCurrent(sales), appointmentPayload({ date: "2030-03-10" }));
    const errors = await fieldErrors(updateAppointment(asCurrent(sales), future.id, appointmentPayload({ date: yesterday(), version: future.version })));
    expect(errors.date).toMatch(/has passed/);
  });
});

describe("slot holds", () => {
  const slot = { date: "2030-03-10", startTime: "10:00", durationMinutes: 120 };

  it("keeps a held technician for the holder while a colleague is refused", async () => {
    const hold = await holdSlot(asCurrent(sales), { ...slot, technicianIds: [lockTech.id] });
    expect(hold.expiresAt).not.toBeNull();

    // A colleague cannot hold or book the same technician over that slot …
    const holdErrors = await fieldErrors(holdSlot(asCurrent(otherSales), { ...slot, startTime: "11:00", technicianIds: [lockTech.id] }));
    expect(holdErrors.technicianIds).toMatch(/is being booked by sales/);
    const bookErrors = await fieldErrors(createAppointment(asCurrent(otherSales), appointmentPayload({ ...slot, technicianIds: [lockTech.id] })));
    expect(bookErrors.technicianIds).toMatch(/Lock Tech is being booked by/);
    // … but can use another technician, or the same one at another time.
    await createAppointment(asCurrent(otherSales), appointmentPayload({ ...slot, technicianIds: [smartTech.id] }));
    await createAppointment(asCurrent(otherSales), appointmentPayload({ ...slot, startTime: "14:00", technicianIds: [lockTech.id] }));

    // The holder books it, which releases the hold.
    await createAppointment(asCurrent(sales), appointmentPayload({ ...slot, technicianIds: [lockTech.id] }));
    expect(await prisma.slotHold.count()).toBe(0);
  });

  it("ignores expired holds and replaces the holder's earlier hold", async () => {
    await holdSlot(asCurrent(sales), { ...slot, technicianIds: [lockTech.id] });
    await holdSlot(asCurrent(sales), { ...slot, technicianIds: [smartTech.id] });
    expect(await prisma.slotHold.findMany({ select: { technicianId: true } })).toEqual([{ technicianId: smartTech.id }]);

    await prisma.slotHold.updateMany({ data: { expiresAt: new Date(Date.now() - 1000) } });
    await createAppointment(asCurrent(otherSales), appointmentPayload({ ...slot, technicianIds: [smartTech.id] }));
  });

  it("cannot hold a technician who is already booked, and an empty list releases", async () => {
    await createAppointment(asCurrent(otherSales), appointmentPayload({ ...slot, technicianIds: [lockTech.id] }));
    const errors = await fieldErrors(holdSlot(asCurrent(sales), { ...slot, technicianIds: [lockTech.id] }));
    expect(errors.technicianIds).toMatch(/already booked/);

    await holdSlot(asCurrent(sales), { ...slot, technicianIds: [smartTech.id] });
    expect(await holdSlot(asCurrent(sales), { ...slot, technicianIds: [] })).toEqual({ technicianIds: [], expiresAt: null });
    expect(await prisma.slotHold.count()).toBe(0);
  });

  it("only people who manage bookings can hold", async () => {
    await expect(holdSlot(asCurrent(lockTech), { ...slot, technicianIds: [smartTech.id] })).rejects.toThrow();
  });
});

describe("technician suggestions", () => {
  it("marks specialty fit, holds and day load, and suggests the free technicians that fit", async () => {
    const startsAt = zonedToUtc("2030-03-10", "15:00", DEFAULT_TIMEZONE);
    const endsAt = new Date(startsAt.getTime() + 3_600_000);
    const bothTech = await makeUser("TECHNICIAN", { name: "Any Tech" });
    // Any Tech already has a morning visit that day; Lock Tech is free all day.
    await createAppointment(asCurrent(sales), appointmentPayload({ date: "2030-03-10", startTime: "09:00", durationMinutes: 60, technicianIds: [bothTech.id] }));

    const rows = await technicianAvailability(prisma, { startsAt, endsAt, timezone: DEFAULT_TIMEZONE, userId: sales.id, category: "SMART_LOCK" });
    const by = (id: string) => rows.find((r) => r.id === id)!;
    expect(by(smartTech.id)).toMatchObject({ fits: false, suggested: false, available: true });
    expect(by(lockTech.id)).toMatchObject({ fits: true, suggested: true, dayLoad: 0 });
    expect(by(bothTech.id)).toMatchObject({ fits: true, suggested: true, dayLoad: 1 });

    await holdSlot(asCurrent(otherSales), { date: "2030-03-10", startTime: "15:00", durationMinutes: 60, technicianIds: [lockTech.id] });
    const held = await technicianAvailability(prisma, { startsAt, endsAt, timezone: DEFAULT_TIMEZONE, userId: sales.id, category: "SMART_LOCK" });
    expect(held.find((r) => r.id === lockTech.id)).toMatchObject({ available: false, suggested: false, held: { byName: otherSales.name } });
    // The holder still sees it as free.
    const own = await technicianAvailability(prisma, { startsAt, endsAt, timezone: DEFAULT_TIMEZONE, userId: otherSales.id, category: "SMART_LOCK" });
    expect(own.find((r) => r.id === lockTech.id)).toMatchObject({ available: true, held: null });
  });

  it("stores a technician's specialty and clears it for other roles", async () => {
    const { user } = await createUser(asCurrent(admin), { name: "New Tech", email: "newtech@test.local", role: "TECHNICIAN", specialty: "LOCK", password: "Password123" });
    expect(user.specialty).toBe("LOCK");
    expect((await updateUser(asCurrent(admin), user.id, { specialty: "" })).specialty).toBeNull();
    expect((await updateUser(asCurrent(admin), user.id, { specialty: "SMART_HOME" })).specialty).toBe("SMART_HOME");
    expect((await updateUser(asCurrent(admin), user.id, { role: "SALES" })).specialty).toBeNull();
  });
});

describe("site preparation", () => {
  it("is saved, kept when left out of an edit, and recorded in the history", async () => {
    const a = await createAppointment(
      asCurrent(sales),
      appointmentPayload({ productCategory: "SMART_HOME", siteReadiness: "PARTIAL", internetStatus: "WORKING", equipmentAt: "OFFICE" }),
    );
    expect(a).toMatchObject({ siteReadiness: "PARTIAL", internetStatus: "WORKING", equipmentAt: "OFFICE" });

    const kept = await updateAppointment(asCurrent(sales), a.id, appointmentPayload({ productCategory: "SMART_HOME", brand: "Aqara", version: a.version }));
    expect(kept).toMatchObject({ siteReadiness: "PARTIAL", internetStatus: "WORKING", equipmentAt: "OFFICE" });

    const ready = await updateAppointment(asCurrent(sales), a.id, appointmentPayload({ productCategory: "SMART_HOME", siteReadiness: "READY", equipmentAt: "", version: kept.version }));
    expect(ready).toMatchObject({ siteReadiness: "READY", equipmentAt: null });
    const history = await getAppointmentHistory(asCurrent(admin), a.id);
    expect(history[0]!.changes).toMatchObject({ siteReadiness: { from: "PARTIAL", to: "READY" }, equipmentAt: { from: "OFFICE", to: null } });
  });

  it("rejects unknown values", async () => {
    const errors = await fieldErrors(createAppointment(asCurrent(sales), appointmentPayload({ siteReadiness: "MAYBE" })));
    expect(errors.siteReadiness).toBeTruthy();
  });

  it("flags smart-home installations whose site is not confirmed ready, and tells the technician to pick up office equipment", async () => {
    const now = new Date();
    // Three days ahead: inside the week the alert covers, past the "confirm by tomorrow" reminder.
    const day = addDaysToKey(todayKey(DEFAULT_TIMEZONE, now), 3);
    const notReady = await createAppointment(
      asCurrent(sales),
      appointmentPayload({ date: day, startTime: "12:00", productCategory: "SMART_HOME", internetStatus: "NOT_WORKING", siteReadiness: "READY", equipmentAt: "OFFICE", technicianIds: [smartTech.id] }),
    );
    const ready = await createAppointment(
      asCurrent(sales),
      appointmentPayload({ date: day, startTime: "16:00", productCategory: "SMART_HOME", internetStatus: "WORKING", siteReadiness: "READY", technicianIds: [smartTech.id] }),
    );
    const inspection = await createAppointment(asCurrent(sales), appointmentPayload({ date: day, startTime: "19:00", productCategory: "SMART_HOME", visitType: "INSPECTION" }));

    const reasons = new Map((await dashboardSummary(asCurrent(admin), now)).attention.map((x) => [x.id, x.reason]));
    expect(reasons.get(notReady.id)).toBe("dash.reason.siteNotReady");
    expect(reasons.get(ready.id)).toBeUndefined();
    expect(reasons.get(inspection.id)).not.toBe("dash.reason.siteNotReady");

    const plan = await dayPlan(asCurrent(admin), day, "en");
    const tech = plan.technicians.find((x) => x.id === smartTech.id)!;
    expect(tech.message).toContain("Pick up the equipment from the office");
    expect(tech.message.match(/Pick up the equipment/g)).toHaveLength(1);
    expect((await getAppointment(asCurrent(admin), notReady.id)).equipmentAt).toBe("OFFICE");
  });
});
