import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { User } from "@prisma/client";
import { createAppointment, getAppointment, listAppointments, updateAppointment } from "@/server/services/appointments";
import { carCheckIn, carLive, carWarning, getRoute, reorderRoute } from "@/server/services/car";
import { addExpense, addReceipt, cancelExpense, listExpenses, payExpenses, readReceipt } from "@/server/services/expenses";
import { attendance } from "@/server/services/field";
import { listNotifications } from "@/server/services/notifications";
import { DEFAULT_SETTINGS, updateSettings } from "@/server/services/settings";
import { DEFAULT_TIMEZONE } from "@/lib/constants";
import { addDaysToKey, todayKey, zonedToUtc } from "@/lib/time";
import { ForbiddenError, NotFoundError, ValidationError } from "@/server/errors";
import { appointmentPayload, asCurrent, makeUser, prisma, resetDb, seedStatuses } from "../helpers";

const tz = DEFAULT_TIMEZONE;
const today = todayKey(tz);
const tomorrow = addDaysToKey(today, 1);
const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 9, 9, 9]);
const COMPANY = { lat: 30.0444, lng: 31.2357 };
const NEAR = { lat: 30.0544, lng: 31.2357 }; // ~1 km from the company
const MID = { lat: 30.0944, lng: 31.2357 }; // ~5.5 km
const FAR = { lat: 30.2944, lng: 31.2357 }; // ~28 km
// Sessions carry the saved settings; the helper builds them from the defaults, so pass the location.
const withCompany = { companyLatitude: COMPANY.lat, companyLongitude: COMPANY.lng };

let dir: string;
let admin: User, sales: User, tech: User, otherTech: User, accountant: User, driver: User;

beforeAll(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), "ims-expenses-"));
  process.env.UPLOAD_DIR = dir;
});
afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

beforeEach(async () => {
  await resetDb();
  await seedStatuses();
  admin = await makeUser("ADMIN");
  sales = await makeUser("SALES");
  tech = await makeUser("TECHNICIAN");
  otherTech = await makeUser("TECHNICIAN");
  accountant = await makeUser("ACCOUNTANT");
  driver = await makeUser("DRIVER", { name: "Dina Driver" });
  await updateSettings(asCurrent(admin), { ...DEFAULT_SETTINGS, companyLatitude: COMPANY.lat, companyLongitude: COMPANY.lng });
});

let seq = 0;
async function book(opts: { date?: string; time?: string; geo?: { lat: number; lng: number } | null; car?: boolean; techs?: string[] } = {}) {
  seq++;
  return createAppointment(
    asCurrent(sales),
    appointmentPayload({
      date: opts.date ?? today,
      startTime: opts.time ?? "11:00",
      durationMinutes: 30,
      technicianIds: opts.techs ?? [],
      needsCar: opts.car ?? true,
      customer: { name: `Customer ${seq}`, phone: `+20 100 000 ${String(2000 + seq)}` },
      location: opts.geo === null ? { area: `Area ${seq}` } : { area: `Area ${seq}`, latitude: String((opts.geo ?? MID).lat), longitude: String((opts.geo ?? MID).lng) },
    }),
  );
}

describe("transport expenses", () => {
  it("lets a technician claim for their own visit with a receipt, and cancel a mistake", async () => {
    const mine = await book({ techs: [tech.id], car: false });
    const theirs = await book({ techs: [otherTech.id], car: false, time: "13:00" });
    await expect(addExpense(asCurrent(tech), { amount: "0" })).rejects.toBeInstanceOf(ValidationError);
    await expect(addExpense(asCurrent(tech), { amount: -5 })).rejects.toBeInstanceOf(ValidationError);
    await expect(addExpense(asCurrent(tech), { amount: 50, appointmentId: theirs.id })).rejects.toBeInstanceOf(NotFoundError);
    await expect(addExpense(asCurrent(sales), { amount: 50 })).rejects.toBeInstanceOf(ForbiddenError);

    const e = await addExpense(asCurrent(tech), { amount: "75.50", appointmentId: mine.id, note: "Taxi" });
    expect(e).toMatchObject({ amount: 75.5, status: "PENDING", note: "Taxi", appointment: { id: mine.id }, canCancel: true, canAddReceipt: true, day: today });

    expect((await addReceipt(asCurrent(tech), e.id, JPEG)).hasReceipt).toBe(true);
    await expect(addReceipt(asCurrent(tech), e.id, JPEG)).rejects.toBeInstanceOf(ValidationError);
    await expect(addReceipt(asCurrent(otherTech), e.id, JPEG)).rejects.toBeInstanceOf(NotFoundError);
    expect((await readReceipt(asCurrent(accountant), e.id)).contentType).toBe("image/jpeg");
    await expect(readReceipt(asCurrent(otherTech), e.id)).rejects.toBeInstanceOf(NotFoundError);

    const wrong = await addExpense(asCurrent(tech), { amount: 999 });
    await expect(cancelExpense(asCurrent(otherTech), wrong.id)).rejects.toBeInstanceOf(NotFoundError);
    expect((await cancelExpense(asCurrent(tech), wrong.id)).status).toBe("CANCELLED");
    await expect(cancelExpense(asCurrent(tech), wrong.id)).rejects.toBeInstanceOf(ValidationError);

    await expect(prisma.$executeRaw`UPDATE transport_expenses SET amount = 1 WHERE id = ${e.id}`).rejects.toThrow(/only a pending expense/);
    await expect(prisma.$executeRaw`DELETE FROM transport_expenses WHERE id = ${e.id}`).rejects.toThrow(/cannot be deleted/);
  });

  it("shows the accountant everyone's month by person and pays one person's pending expenses at once", async () => {
    await addExpense(asCurrent(tech), { amount: 40 });
    await addExpense(asCurrent(tech), { amount: 60 });
    await addExpense(asCurrent(driver), { amount: 25 });
    const cancelled = await addExpense(asCurrent(tech), { amount: 500 });
    await cancelExpense(asCurrent(tech), cancelled.id);

    const own = await listExpenses(asCurrent(tech));
    expect(own.canPay).toBe(false);
    expect(own.items).toHaveLength(3);
    const all = await listExpenses(asCurrent(accountant));
    expect(all.summary.map((s) => [s.user.id, s.total, s.pending, s.count])).toEqual([
      [tech.id, 100, 100, 2],
      [driver.id, 25, 25, 1],
    ]);
    expect(all).toMatchObject({ total: 125, pending: 125 });

    await expect(payExpenses(asCurrent(tech), { userId: tech.id, month: today.slice(0, 7) })).rejects.toBeInstanceOf(ForbiddenError);
    expect(await payExpenses(asCurrent(accountant), { userId: tech.id, month: today.slice(0, 7) })).toEqual({ count: 2, total: 100 });
    expect(await payExpenses(asCurrent(accountant), { userId: tech.id, month: today.slice(0, 7) })).toEqual({ count: 0, total: 0 });
    const after = await listExpenses(asCurrent(accountant));
    expect(after).toMatchObject({ total: 125, pending: 25 });
    expect(after.items.find((i) => i.user.id === tech.id && i.status === "PAID")?.paidBy?.id).toBe(accountant.id);
    expect((await listNotifications(asCurrent(tech))).items.some((n) => n.type === "CASH")).toBe(true);
    expect(await prisma.auditLog.count({ where: { action: "EXPENSES_PAID" } })).toBe(1);
  });
});

describe("company car", () => {
  it("lets the driver see only the visits the car serves", async () => {
    const carVisit = await book({ car: true });
    const plain = await book({ car: false, time: "15:00" });
    expect(carVisit.needsCar).toBe(true);
    expect((await getAppointment(asCurrent(driver), carVisit.id)).id).toBe(carVisit.id);
    await expect(getAppointment(asCurrent(driver), plain.id)).rejects.toBeInstanceOf(NotFoundError);
    const list = await listAppointments(asCurrent(driver), { sort: "startsAt", dir: "asc", page: 1, pageSize: 50 });
    expect(list.rows.map((i) => i.id)).toEqual([carVisit.id]);
    // Unticking the car clears its place in the route.
    await prisma.appointment.update({ where: { id: carVisit.id }, data: { carSeq: 2 } });
    const edited = await updateAppointment(asCurrent(sales), carVisit.id, { ...appointmentPayload({ date: today, startTime: "11:00", durationMinutes: 30 }), needsCar: false, version: carVisit.version + 0 });
    expect(edited.needsCar).toBe(false);
    expect((await prisma.appointment.findUniqueOrThrow({ where: { id: carVisit.id } })).carSeq).toBeNull();
  });

  it("orders the stops by hand first, then each period from the nearest stop, with Aura's warnings", async () => {
    const far = await book({ time: "11:00", geo: FAR });
    const near = await book({ time: "11:30", geo: NEAR });
    const mid = await book({ time: "12:00", geo: MID });
    const afternoon = await book({ time: "15:00", geo: MID });
    await book({ car: false, time: "16:00" });

    let route = await getRoute(asCurrent(admin, withCompany));
    expect(route.stops.map((s) => s.id)).toEqual([near.id, mid.id, far.id, afternoon.id]);
    expect(route.stops.map((s) => s.slot)).toEqual([1, 1, 1, 2]);
    // FAR is ~28 km from both others in the morning.
    expect(route.warnings.filter((w) => w.slot === 1)).toHaveLength(2);
    expect(route).toMatchObject({ canReorder: true, canCheckIn: true });

    await expect(reorderRoute(asCurrent(sales), { day: today, ids: [afternoon.id] })).rejects.toBeInstanceOf(ForbiddenError);
    await expect(reorderRoute(asCurrent(admin, withCompany), { day: today, ids: ["nope"] })).rejects.toBeInstanceOf(ValidationError);
    route = await reorderRoute(asCurrent(admin, withCompany), { day: today, ids: [afternoon.id] });
    expect(route.stops.map((s) => s.id)).toEqual([afternoon.id, mid.id, near.id, far.id]);
    expect(route.stops[0]!.manual).toBe(true);

    await book({ time: "12:30", geo: NEAR });
    expect((await getRoute(asCurrent(admin, withCompany))).warnings.some((w) => w.message.startsWith("car.warnMany") && w.message.includes("\"count\":4"))).toBe(true);
    const tomorrowRoute = await getRoute(asCurrent(driver), tomorrow);
    expect(tomorrowRoute).toMatchObject({ stops: [], canCheckIn: false, canReorder: false });
  });

  it("records the car leaving, dropping and picking up the teams and coming back, and shows it on the board", async () => {
    const visit = await book({ time: "11:00", geo: MID, techs: [tech.id] });
    const plain = await book({ car: false, time: "14:00" });
    const at = (time: string) => zonedToUtc(today, time, tz);
    await expect(carCheckIn(asCurrent(driver), { kind: "CAR_BACK" }, at("10:00"))).rejects.toBeInstanceOf(ValidationError);
    await expect(carCheckIn(asCurrent(tech), { kind: "CAR_GO" })).rejects.toBeInstanceOf(ForbiddenError);
    const go = await carCheckIn(asCurrent(driver), { kind: "CAR_GO", geo: COMPANY }, at("10:20"));
    expect(go.lateMinutes).toBe(20);
    await expect(carCheckIn(asCurrent(driver), { kind: "CAR_DROP", appointmentId: plain.id })).rejects.toBeInstanceOf(NotFoundError);
    const drop = await carCheckIn(asCurrent(driver), { kind: "CAR_DROP", appointmentId: visit.id, geo: FAR }, at("10:50"));
    expect(drop.far).toBe(true);
    expect((await carCheckIn(asCurrent(driver), { kind: "CAR_DROP", appointmentId: visit.id }, at("10:55"))).duplicate).toBe(true);
    await carCheckIn(asCurrent(driver), { kind: "CAR_PICK", appointmentId: visit.id, geo: MID }, at("12:00"));
    const back = await carCheckIn(asCurrent(driver), { kind: "CAR_BACK", geo: COMPANY }, at("18:00"));
    expect(back.earlyMinutes).toBe(60);

    const route = await getRoute(asCurrent(admin, withCompany));
    expect(route.stops[0]).toMatchObject({ id: visit.id, drop: expect.any(String), pick: expect.any(String) });
    expect(route.go).not.toBeNull();
    expect(route.back).not.toBeNull();
    expect(await carLive(asCurrent(admin, withCompany), at("18:05"))).toMatchObject({ state: "back", tone: "green", dropped: 1, total: 1 });
    expect((await attendance(asCurrent(accountant), today.slice(0, 7))).rows.find((r) => r.technician.id === driver.id)).toMatchObject({ days: 1, lateDays: 1, earlyLeaves: 1 });
  });

  it("warns while booking when the car is already busy or far away in that period", async () => {
    await book({ time: "11:00", geo: NEAR });
    const q = (geo: { lat: number; lng: number }, time = "12:00") => carWarning(asCurrent(sales), { date: today, time, lat: String(geo.lat), lng: String(geo.lng) });
    expect(await q(MID)).toMatchObject({ level: "info", message: expect.stringMatching(/^car\.bookOthers/) });
    expect(await q(FAR)).toMatchObject({ level: "danger", message: expect.stringMatching(/^car\.bookFar/) });
    expect((await q(MID, "15:00")).message).toBeNull();
    await book({ time: "11:30", geo: NEAR });
    await book({ time: "12:30", geo: NEAR });
    expect(await q(MID)).toMatchObject({ level: "warning", message: expect.stringMatching(/^car\.bookMany/) });
    await expect(carWarning(asCurrent(driver), { date: today, time: "12:00" })).rejects.toBeInstanceOf(ForbiddenError);
  });
});
