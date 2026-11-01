import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { User } from "@prisma/client";
import { POST as lateCheckRoute } from "@/app/api/cron/late-check/route";
import { createAppointment, getAppointment, getAppointmentHistory, recordVisitOutcome } from "@/server/services/appointments";
import { setCustomerRating, setQualityGrade } from "@/server/services/after-sales";
import { attendance, insertCheckIn, lateItems, liveBoard, recordCheckIn, runLateCheck, visitCheckIns } from "@/server/services/field";
import { createLeave } from "@/server/services/leaves";
import { listNotifications } from "@/server/services/notifications";
import { DEFAULT_SETTINGS, getSettings, updateSettings } from "@/server/services/settings";
import { DEFAULT_TIMEZONE } from "@/lib/constants";
import { addDaysToKey, addMonthsToKey, startOfMonthKey, todayKey, weekdayOfKey, zonedToUtc } from "@/lib/time";
import { ForbiddenError, NotFoundError, ValidationError } from "@/server/errors";
import { appointmentPayload, asCurrent, makeUser, prisma, resetDb, seedStatuses } from "../helpers";

const tz = DEFAULT_TIMEZONE;
const today = todayKey(tz);
const at = (day: string, time: string) => zonedToUtc(day, time, tz);
// The company and a customer about 5 km apart in Cairo.
const COMPANY = { lat: 30.0444, lng: 31.2357 };
const CUSTOMER = { lat: 30.0894, lng: 31.2357 };
const near = (p: { lat: number; lng: number }) => ({ lat: p.lat + 0.0005, lng: p.lng, acc: 12 }); // ~55 m
const far = (p: { lat: number; lng: number }) => ({ lat: p.lat + 0.005, lng: p.lng, acc: 12 }); // ~555 m

let admin: User, sales: User, tech: User, otherTech: User, accountant: User, viewer: User, screen: User;

beforeEach(async () => {
  await resetDb();
  await seedStatuses();
  admin = await makeUser("ADMIN");
  sales = await makeUser("SALES");
  tech = await makeUser("TECHNICIAN", { name: "Aaron Tech" });
  otherTech = await makeUser("TECHNICIAN", { name: "Bea Tech" });
  accountant = await makeUser("ACCOUNTANT");
  viewer = await makeUser("VIEWER", { viewerPermissions: ["appointments.view"] });
  screen = await makeUser("VIEWER", { viewerPermissions: ["appointments.view", "board.view"] });
  await updateSettings(asCurrent(admin), { ...DEFAULT_SETTINGS, companyLatitude: COMPANY.lat, companyLongitude: COMPANY.lng, revisitFee: 300 });
});

afterEach(() => {
  delete process.env.CRON_SECRET;
});

let seq = 0;
async function book(date: string, overrides: Record<string, unknown> = {}) {
  seq++;
  return createAppointment(
    // Past visits can only be booked by an Admin; on behalf of the Sales employee.
    asCurrent(admin),
    appointmentPayload({
      date,
      startTime: "12:00",
      durationMinutes: 60,
      technicianIds: [tech.id],
      location: { area: "Shubra", latitude: String(CUSTOMER.lat), longitude: String(CUSTOMER.lng) },
      customer: { name: `Customer ${seq}`, phone: `+20 100 000 ${String(1000 + seq)}` },
      salesUserId: sales.id,
      ...overrides,
    }),
  );
}

describe("check-ins", () => {
  it("flags a late arrival far from the company, refuses leaving before arriving, and flags an early departure", async () => {
    await expect(recordCheckIn(asCurrent(tech), { kind: "LEAVE", geo: near(COMPANY) }, at(today, "09:00"))).rejects.toBeInstanceOf(ValidationError);
    const arrive = await recordCheckIn(asCurrent(tech), { kind: "COMPANY", geo: far(COMPANY) }, at(today, "10:40"));
    expect(arrive).toMatchObject({ kind: "COMPANY", hasLocation: true, far: true, lateMinutes: 40 });
    expect(arrive.distanceM).toBeGreaterThan(500);
    expect((await listNotifications(asCurrent(admin))).items.some((n) => n.type === "LATE")).toBe(true);
    // Pressing again returns the first check-in.
    const again = await recordCheckIn(asCurrent(tech), { kind: "COMPANY" }, at(today, "10:50"));
    expect(again).toMatchObject({ id: arrive.id, duplicate: true });

    const onTime = await recordCheckIn(asCurrent(otherTech), { kind: "COMPANY", geo: near(COMPANY) }, at(today, "10:10"));
    expect(onTime).toMatchObject({ far: false, lateMinutes: null });
    const noGeo = await recordCheckIn(asCurrent(otherTech), { kind: "LEAVE" }, at(today, "19:05"));
    expect(noGeo).toMatchObject({ hasLocation: false, earlyMinutes: null });

    const leave = await recordCheckIn(asCurrent(tech), { kind: "LEAVE", geo: near(COMPANY) }, at(today, "18:00"));
    expect(leave.earlyMinutes).toBe(60);
    await expect(recordCheckIn(asCurrent(sales), { kind: "COMPANY" })).rejects.toBeInstanceOf(ForbiddenError);
    await expect(prisma.$executeRaw`UPDATE check_ins SET note = 'x' WHERE id = ${leave.id}`).rejects.toThrow(/append-only/);
    await expect(prisma.$executeRaw`DELETE FROM check_ins WHERE id = ${leave.id}`).rejects.toThrow(/append-only/);
  });

  it("asks for the call to the customer before setting off, estimates the arrival and flags a far arrival", async () => {
    const a = await book(today);
    await expect(recordCheckIn(asCurrent(tech), { kind: "DEPART", appointmentId: a.id }, at(today, "11:00"))).rejects.toBeInstanceOf(ValidationError);
    await expect(recordCheckIn(asCurrent(otherTech), { kind: "READY", appointmentId: a.id })).rejects.toBeInstanceOf(NotFoundError);
    await expect(recordCheckIn(asCurrent(tech), { kind: "START", appointmentId: a.id })).rejects.toBeInstanceOf(ValidationError);
    await recordCheckIn(asCurrent(tech), { kind: "READY", appointmentId: a.id }, at(today, "11:00"));
    const depart = await recordCheckIn(asCurrent(tech), { kind: "DEPART", appointmentId: a.id, geo: near(COMPANY) }, at(today, "11:05"));
    // ~5 km × 1.4 at 25 km/h + 5 min ≈ 22 minutes.
    const minutes = (Date.parse(depart.etaAt!) - at(today, "11:05").getTime()) / 60_000;
    expect(minutes).toBeGreaterThan(17);
    expect(minutes).toBeLessThan(27);
    expect((await listNotifications(asCurrent(sales))).items[0]!.message).toMatch(/on the way .* arriving around/);

    const arrive = await recordCheckIn(asCurrent(tech), { kind: "ARRIVE", appointmentId: a.id, geo: far(CUSTOMER) }, at(today, "11:30"));
    expect(arrive.far).toBe(true);
    expect((await listNotifications(asCurrent(sales))).items[0]!.message).toMatch(/m from the saved location/);

    // Start and finish come with the outcome, with the phone's location.
    const started = await recordVisitOutcome(asCurrent(tech), a.id, { outcome: "IN_PROGRESS", geo: near(CUSTOMER), version: a.version });
    await recordVisitOutcome(asCurrent(tech), a.id, { outcome: "COMPLETED", report: "Done", geo: near(CUSTOMER), version: started.version });
    const log = await visitCheckIns(asCurrent(sales), a.id);
    // START and DONE carry the real clock, the others the times given above: compare as a set.
    expect(log.map((c) => c.kind).sort()).toEqual(["ARRIVE", "DEPART", "DONE", "READY", "START"]);
    expect(log.find((c) => c.kind === "START")).toMatchObject({ far: false, hasLocation: true });
    expect((await visitCheckIns(asCurrent(tech), a.id)).length).toBe(5);
  });

  it("adds the repeat-visit fee once when the customer caused the problem, and tells Sales and the Admins", async () => {
    const a = await book(today, { totalPrice: 2000 });
    await expect(recordCheckIn(asCurrent(tech), { kind: "PROBLEM", appointmentId: a.id })).rejects.toBeInstanceOf(ValidationError);
    await expect(recordCheckIn(asCurrent(tech), { kind: "PROBLEM", appointmentId: a.id, reason: "weather" })).rejects.toBeInstanceOf(ValidationError);
    await recordCheckIn(asCurrent(tech), { kind: "PROBLEM", appointmentId: a.id, reason: "customerAbsent", note: "Called 3 times" });
    const after = await getAppointment(asCurrent(sales), a.id);
    expect(after.payment?.extraFee).toBe(300);
    expect(after.version).toBe(a.version + 1);
    expect((await getAppointmentHistory(asCurrent(sales), a.id))[0]).toMatchObject({ action: "REVISIT_FEE" });
    await recordCheckIn(asCurrent(tech), { kind: "PROBLEM", appointmentId: a.id, reason: "siteNotReady" });
    expect((await getAppointment(asCurrent(sales), a.id)).payment?.extraFee).toBe(300);
    expect((await listNotifications(asCurrent(admin))).items.filter((n) => n.type === "FIELD")).toHaveLength(2);

    const b = await book(addDaysToKey(today, 1), { totalPrice: 2000 });
    await recordCheckIn(asCurrent(tech), { kind: "PROBLEM", appointmentId: b.id, reason: "missingParts" });
    expect((await getAppointment(asCurrent(sales), b.id)).payment?.extraFee ?? null).toBeNull();
  });
});

describe("live board and late alerts", () => {
  it("shows where each technician is, worst first, to Admins and the office screen only", async () => {
    const third = await makeUser("TECHNICIAN", { name: "Cid Tech" });
    const fourth = await makeUser("TECHNICIAN", { name: "Dee Tech" });
    await makeUser("TECHNICIAN", { name: "Eve Tech" }); // no visits today
    const atClient = await book(today, { startTime: "08:00" });
    const onWay = await book(today, { technicianIds: [otherTech.id], startTime: "09:00" });
    await book(today, { technicianIds: [third.id], startTime: "13:00" });
    await book(today, { technicianIds: [fourth.id], startTime: "14:00" });
    const now = new Date();
    await recordCheckIn(asCurrent(tech), { kind: "ARRIVE", appointmentId: atClient.id, geo: near(CUSTOMER) }, now);
    await recordCheckIn(asCurrent(otherTech), { kind: "READY", appointmentId: onWay.id }, now);
    await recordCheckIn(asCurrent(otherTech), { kind: "DEPART", appointmentId: onWay.id, geo: near(COMPANY) }, now);
    await createLeave(asCurrent(admin), { userId: fourth.id, startDate: today, endDate: today, type: "SICK" });

    const board = await liveBoard(asCurrent(admin), now);
    const byName = Object.fromEntries(board.rows.map((r) => [r.technician.name, r]));
    expect(byName["Aaron Tech"]).toMatchObject({ state: "atClient", tone: "green" });
    expect(byName["Bea Tech"]!.state).toBe("onWay");
    expect(byName["Bea Tech"]!.etaAt).not.toBeNull();
    expect(byName["Dee Tech"]).toMatchObject({ state: "leave", tone: "red", leaveType: "SICK" });
    expect(byName["Eve Tech"]).toMatchObject({ state: "free", tone: "grey" });
    expect(["notYet"]).toContain(byName["Cid Tech"]!.state);
    expect(board.rows[0]!.tone).toBe("red");
    expect(board.rows.at(-1)!.tone).toBe("grey");

    expect((await liveBoard(asCurrent(screen), now)).rows).toHaveLength(5);
    await expect(liveBoard(asCurrent(viewer), now)).rejects.toBeInstanceOf(ForbiddenError);
    await expect(liveBoard(asCurrent(sales), now)).rejects.toBeInstanceOf(ForbiddenError);
  });

  it("sends each late alert once a day, only on working days and hours, through a secret-protected endpoint", async () => {
    // Pick a recent weekday that is not closed, to judge "now" on it.
    const day = today;
    const late = await book(day, { startTime: "11:00" });
    const onTheWay = await book(day, { technicianIds: [otherTech.id], startTime: "11:00" });
    await recordCheckIn(asCurrent(otherTech), { kind: "COMPANY" }, at(day, "10:00"));
    await recordCheckIn(asCurrent(otherTech), { kind: "READY", appointmentId: onTheWay.id }, at(day, "10:30"));
    await recordCheckIn(asCurrent(otherTech), { kind: "DEPART", appointmentId: onTheWay.id, geo: near(COMPANY) }, at(day, "10:31"));

    const { items } = await lateItems(at(day, "11:40"));
    expect(items.map((i) => i.key).sort()).toEqual([`ar|${late.id}|${tech.id}`, `co|${tech.id}`, `eta|${onTheWay.id}|${otherTech.id}`].sort());
    expect((await lateItems(at(day, "09:00"))).items).toHaveLength(0);

    expect(await runLateCheck(at(day, "11:40"))).toMatchObject({ sent: 3 });
    expect(await runLateCheck(at(day, "11:55"))).toMatchObject({ sent: 0 });
    expect((await listNotifications(asCurrent(admin))).items.filter((n) => n.type === "LATE")).toHaveLength(3);

    await updateSettings(asCurrent(admin), { ...(await getSettings()), closedWeekdays: [weekdayOfKey(day)] });
    expect((await lateItems(at(day, "11:40"))).items).toHaveLength(0);

    const call = (auth?: string) => lateCheckRoute(new Request("http://localhost/api/cron/late-check", { method: "POST", headers: auth ? { authorization: auth } : {} }));
    expect((await call("Bearer whatever")).status).toBe(503);
    process.env.CRON_SECRET = "a-long-enough-secret-123";
    expect((await call()).status).toBe(401);
    expect((await call("Bearer wrong-secret-of-same-size!")).status).toBe(401);
    const ok = await call("Bearer a-long-enough-secret-123");
    expect(ok.status).toBe(200);
    expect(await ok.json()).toMatchObject({ sent: 0 });
  });
});

describe("attendance and points", () => {
  it("counts days, lateness, leave and absences and scores the month like Aura", async () => {
    const month = addMonthsToKey(startOfMonthKey(today), -1).slice(0, 7);
    const d1 = `${month}-03`;
    const d2 = `${month}-04`;
    const d3 = `${month}-05`;
    const v1 = await book(d1, { startTime: "12:00" });
    await book(d2, { startTime: "12:00" }); // no check-in that day: absent
    await createLeave(asCurrent(admin), { userId: tech.id, startDate: d3, endDate: d3, type: "SICK" });

    await recordCheckIn(asCurrent(tech), { kind: "COMPANY", geo: near(COMPANY) }, at(d1, "10:30"));
    await recordCheckIn(asCurrent(tech), { kind: "ARRIVE", appointmentId: v1.id, geo: near(CUSTOMER) }, at(d1, "12:10"));
    const settings = await getSettings();
    const visit = { id: v1.id, number: 1, createdById: sales.id, customerName: "x", latitude: CUSTOMER.lat, longitude: CUSTOMER.lng };
    await prisma.$transaction((tx) => insertCheckIn(tx, tech, "DONE", visit, near(CUSTOMER), settings, {}, at(d1, "13:10")));
    await recordCheckIn(asCurrent(tech), { kind: "LEAVE" }, at(d1, "19:00"));
    const done = await recordVisitOutcome(asCurrent(sales), v1.id, { outcome: "COMPLETED", report: "Done", version: v1.version });
    await setCustomerRating(asCurrent(sales), done.id, { rating: 5, note: null });
    await setQualityGrade(asCurrent(admin), done.id, { grade: 4 });

    const all = await attendance(asCurrent(accountant), month);
    const row = all.rows.find((r) => r.technician.id === tech.id)!;
    expect(row).toMatchObject({
      days: 1,
      avgIn: "10:30",
      avgOut: "19:00",
      lateDays: 1,
      lateMinutes: 30,
      earlyLeaves: 0,
      sickDays: 1,
      leaveDays: 0,
      absences: 1,
      absentDates: [d2],
      visits: 2,
      done: 1,
      arrived: 1,
      onTime: 1,
      ratingAvg: 5,
      gradeAvg: 4,
      avgVisitMinutes: 60,
    });
    // 40 (on time) + 30 (rating 5) + 16 (grade 4) + 1 (done) - 2 (late day) - 5 (absence)
    expect(row.points).toBe(80);
    expect(all.rows.find((r) => r.technician.id === otherTech.id)!.points).toBe(0);

    const mine = await attendance(asCurrent(tech), month);
    expect(mine.rows.map((r) => r.technician.id)).toEqual([tech.id]);
    await expect(attendance(asCurrent(sales), month)).rejects.toBeInstanceOf(ForbiddenError);
    expect((await attendance(asCurrent(accountant), "nonsense")).month).toBe(today.slice(0, 7));
  });
});
