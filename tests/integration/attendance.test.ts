import { beforeEach, describe, expect, it } from "vitest";
import type { User } from "@prisma/client";
import { createAppointment } from "@/server/services/appointments";
import { attendanceRange, clock, clockState, readSelfie, reviewCheckIn, saveWorkLocation } from "@/server/services/attendance";
import { recordCheckIn } from "@/server/services/field";
import { listNotifications } from "@/server/services/notifications";
import { DEFAULT_SETTINGS, updateSettings } from "@/server/services/settings";
import { ForbiddenError, NotFoundError, ValidationError } from "@/server/errors";
import { DEFAULT_TIMEZONE } from "@/lib/constants";
import { addDaysToKey, todayKey, zonedToUtc } from "@/lib/time";
import { appointmentPayload, asCurrent, makeUser, prisma, resetDb, seedStatuses } from "../helpers";

/** Clock-in / clock-out with a selfie and geofences, the review of flagged records, and the reports. */
const tz = DEFAULT_TIMEZONE;
const today = todayKey(tz);
const at = (day: string, time: string) => zonedToUtc(day, time, tz);
const COMPANY = { lat: 30.0444, lng: 31.2357 };
const SITE = { lat: 30.0894, lng: 31.2357 };
const near = (p: { lat: number; lng: number }, acc = 12) => ({ lat: p.lat + 0.0005, lng: p.lng, acc }); // ~55 m
const away = (p: { lat: number; lng: number }) => ({ lat: p.lat + 0.005, lng: p.lng, acc: 12 }); // ~555 m
// A JPEG is recognised by its first bytes; the rest does not matter for storage.
const SELFIE = `data:image/jpeg;base64,${Buffer.from([0xff, 0xd8, 0xff, 0xe0, ...Array.from({ length: 64 }, (_, i) => i)]).toString("base64")}`;

let admin: User, sales: User, tech: User, otherTech: User, accountant: User;

beforeEach(async () => {
  await resetDb();
  await seedStatuses();
  admin = await makeUser("ADMIN");
  sales = await makeUser("SALES");
  tech = await makeUser("TECHNICIAN", { name: "Aaron Tech" });
  otherTech = await makeUser("TECHNICIAN", { name: "Bea Tech" });
  accountant = await makeUser("ACCOUNTANT");
  await updateSettings(asCurrent(admin), { ...DEFAULT_SETTINGS, companyLatitude: COMPANY.lat, companyLongitude: COMPANY.lng });
});

const t = (u: User) => asCurrent(u);
const clockIn = (u: User, body: Record<string, unknown>, now: Date) => clock(t(u), { action: "IN", site: "COMPANY", selfie: SELFIE, ...body }, now);

describe("clock in and out", () => {
  it("records the server's time, the position, the distance and the photo; never a time from the browser", async () => {
    const now = at(today, "09:50");
    const r = await clockIn(tech, { geo: near(COMPANY), at: "2020-01-01T00:00:00Z", createdAt: "2020-01-01T00:00:00Z" }, now);
    expect(r).toMatchObject({ kind: "COMPANY", site: "COMPANY", geofenceM: 400, accuracyM: 12, hasSelfie: true, flags: { outside: false, noLocation: false, lowAccuracy: false, late: false } });
    expect(r.distanceM).toBeGreaterThan(40);
    expect(r.distanceM).toBeLessThan(70);
    expect(r.at).toBe(now.toISOString());
    // Once a day: a second clock-in returns the first.
    const again = await clockIn(tech, { geo: near(COMPANY) }, at(today, "10:30"));
    expect(again).toMatchObject({ id: r.id, duplicate: true });
    // The photo is the person's and the attendance managers' only.
    expect((await readSelfie(t(tech), r.id)).contentType).toBe("image/jpeg");
    expect((await readSelfie(t(accountant), r.id)).bytes.byteLength).toBeGreaterThan(10);
    await expect(readSelfie(t(otherTech), r.id)).rejects.toBeInstanceOf(NotFoundError);
    // Check-ins stay append-only.
    await expect(prisma.checkIn.update({ where: { id: r.id }, data: { latitude: 1 } })).rejects.toThrow();
  });

  it("flags a clock-in outside the geofence, without a location, or with a poor reading, and tells the Admins", async () => {
    const out = await clockIn(tech, { geo: away(COMPANY) }, at(today, "09:55"));
    expect(out.flags.outside).toBe(true);
    const none = await clockIn(otherTech, { geo: null }, at(today, "09:56"));
    expect(none.flags).toMatchObject({ noLocation: true, outside: false });
    const notes = await listNotifications(t(admin));
    expect(notes.items.map((n) => n.message).join(" | ")).toMatch(/outside the geofence/);
    expect(notes.items.map((n) => n.message).join(" | ")).toMatch(/without a location/);
    const blurry = await clockIn(admin, { geo: near(COMPANY, 900) }, at(today, "09:57"));
    expect(blurry.flags.lowAccuracy).toBe(true);
  });

  it("uses the configured radius and the late / early rules", async () => {
    await updateSettings(t(admin), { ...DEFAULT_SETTINGS, companyLatitude: COMPANY.lat, companyLongitude: COMPANY.lng, companyRadiusM: 1000 });
    const r = await clockIn(tech, { geo: away(COMPANY) }, at(today, "10:40"));
    expect(r).toMatchObject({ geofenceM: 1000, flags: { outside: false, late: true }, lateMinutes: 40 });
    const out = await clock(t(tech), { action: "OUT", site: "COMPANY", geo: near(COMPANY), selfie: SELFIE }, at(today, "18:00"));
    expect(out).toMatchObject({ kind: "LEAVE", earlyMinutes: 60, flags: { early: true } });
  });

  it("refuses a clock-out before a clock-in, a missing or fake photo, and people who do not clock in", async () => {
    await expect(clock(t(tech), { action: "OUT", site: "COMPANY", geo: near(COMPANY), selfie: SELFIE }, at(today, "18:00"))).rejects.toBeInstanceOf(ValidationError);
    await expect(clockIn(tech, { geo: near(COMPANY), selfie: "" }, at(today, "10:00"))).rejects.toBeInstanceOf(ValidationError);
    const notImage = `data:image/jpeg;base64,${Buffer.from("<svg xmlns='http://www.w3.org/2000/svg'/>").toString("base64")}`;
    await expect(clockIn(tech, { geo: near(COMPANY), selfie: notImage }, at(today, "10:00"))).rejects.toMatchObject({ fieldErrors: { selfie: expect.any(String) } });
    await expect(clockIn(sales, { geo: near(COMPANY) }, at(today, "10:00"))).rejects.toBeInstanceOf(ForbiddenError);
    expect(await prisma.checkIn.count()).toBe(0);
  });

  it("checks a customer-site clock-in against today's visit pin, and a work location against its own geofence", async () => {
    const visit = await createAppointment(t(admin), appointmentPayload({ date: today, startTime: "12:00", durationMinutes: 60, technicianIds: [tech.id], salesUserId: sales.id, location: { area: "Shubra", latitude: String(SITE.lat), longitude: String(SITE.lng) } }));
    await expect(clockIn(otherTech, { site: "CUSTOMER", appointmentId: visit.id, geo: near(SITE) }, at(today, "09:00"))).rejects.toThrow();
    const r = await clockIn(tech, { site: "CUSTOMER", appointmentId: visit.id, geo: near(SITE) }, at(today, "09:00"));
    expect(r).toMatchObject({ site: "CUSTOMER", appointmentId: visit.id, geofenceM: 300, flags: { outside: false } });
    const state = await clockState(t(tech), at(today, "09:01"));
    expect(state.visits.map((v) => v.id)).toEqual([visit.id]);
    expect(state.clockIn?.id).toBe(r.id);

    const id = await saveWorkLocation(t(admin), null, { name: "Branch", latitude: 30.1, longitude: 31.3, radiusM: 150 });
    await expect(saveWorkLocation(t(tech), null, { name: "X", latitude: 1, longitude: 1, radiusM: 100 })).rejects.toBeInstanceOf(ForbiddenError);
    const w = await clockIn(otherTech, { site: "WORK_LOCATION", workLocationId: id, geo: { lat: 30.1, lng: 31.3, acc: 10 } }, at(today, "09:30"));
    expect(w).toMatchObject({ site: "WORK_LOCATION", geofenceM: 150, distanceM: 0, flags: { outside: false } });
  });

  it("turns off the quick clock buttons once a photo is required", async () => {
    expect((await recordCheckIn(t(tech), { kind: "COMPANY", geo: near(COMPANY) }, at(today, "09:00"))).kind).toBe("COMPANY");
    await updateSettings(t(admin), { ...DEFAULT_SETTINGS, companyLatitude: COMPANY.lat, companyLongitude: COMPANY.lng, attendanceSelfieRequired: true });
    await expect(recordCheckIn(t(otherTech), { kind: "COMPANY", geo: near(COMPANY) }, at(today, "09:00"))).rejects.toThrow(/clock page/);
  });
});

describe("review and reports", () => {
  it("lists present, absent, late, early and missing clock-outs, and lets a manager review flagged days", async () => {
    const yesterday = addDaysToKey(today, -1);
    // Yesterday: tech clocked in outside the geofence and never clocked out; otherTech had a visit and no clock-in.
    const r = await clockIn(tech, { geo: away(COMPANY) }, at(yesterday, "10:30"));
    await createAppointment(t(admin), appointmentPayload({ date: yesterday, startTime: "12:00", durationMinutes: 60, technicianIds: [otherTech.id], salesUserId: sales.id }));
    const report = await attendanceRange(t(admin), yesterday, yesterday, {}, at(today, "12:00"));
    const mine = report.rows.find((x) => x.person.id === tech.id)!;
    expect(mine).toMatchObject({ status: "present", missingCheckout: true, needsReview: true });
    expect(mine.clockIn?.flags).toMatchObject({ outside: true, late: true });
    expect(report.rows.find((x) => x.person.id === otherTech.id)!.status).toBe("absent");
    expect(report.summary.find((s) => s.person.id === tech.id)).toMatchObject({ present: 1, late: 1, missingCheckout: 1, flagged: 1 });

    await expect(reviewCheckIn(t(admin), r.id, { decision: "REJECTED" })).rejects.toMatchObject({ fieldErrors: { note: expect.any(String) } });
    await expect(reviewCheckIn(t(tech), r.id, { decision: "ACCEPTED" })).rejects.toBeInstanceOf(ForbiddenError);
    await reviewCheckIn(t(admin), r.id, { decision: "ACCEPTED", note: "Was at the supplier" });
    const after = await attendanceRange(t(admin), yesterday, yesterday, {}, at(today, "12:00"));
    expect(after.rows.find((x) => x.person.id === tech.id)).toMatchObject({ needsReview: false, review: { decision: "ACCEPTED", note: "Was at the supplier" } });
    const review = await prisma.attendanceReview.findFirstOrThrow();
    await expect(prisma.attendanceReview.update({ where: { id: review.id }, data: { note: "changed" } })).rejects.toThrow(/append-only/);
    expect(await prisma.auditLog.count({ where: { action: "ATTENDANCE_ACCEPTED" } })).toBe(1);

    // A technician sees only their own days.
    const own = await attendanceRange(t(otherTech), yesterday, today, {}, at(today, "12:00"));
    expect(new Set(own.rows.map((x) => x.person.id))).toEqual(new Set([otherTech.id]));
  });
});
