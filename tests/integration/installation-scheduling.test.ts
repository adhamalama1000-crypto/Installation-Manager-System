import { beforeEach, describe, expect, it } from "vitest";
import type { User } from "@prisma/client";
import { createAppointment, getAppointment, updateAppointment } from "@/server/services/appointments";
import { companySchedule } from "@/server/services/company-schedule";
import { createLeave } from "@/server/services/leaves";
import { listNotifications } from "@/server/services/notifications";
import { openRescheduleRequests, requestReschedule, resolveReschedule, visitRescheduleRequests } from "@/server/services/reschedule-requests";
import { technicianAvailability } from "@/server/services/scheduling";
import { listWorkHours, setWorkHours, workingHoursViolations } from "@/server/services/work-hours";
import { DEFAULT_TIMEZONE } from "@/lib/constants";
import { computeEnd, zonedToUtc } from "@/lib/time";
import { ForbiddenError, NotFoundError, SchedulingConflictError, ValidationError } from "@/server/errors";
import { appointmentPayload, asCurrent, makeUser, prisma, resetDb, seedStatuses } from "../helpers";

/**
 * Installation scheduling: technicians' working hours, the override of soft rules with an audited
 * reason (hard rules stay hard), the read-only company schedule with customer details protected,
 * reschedule requests from technicians, and removal jobs.
 */

const tz = DEFAULT_TIMEZONE;
const SUNDAY = "2030-03-10"; // weekday 0
const MONDAY = "2030-03-11"; // weekday 1

// Sunday to Thursday 09:00-17:00, Friday off, Saturday working with no set hours.
const WEEK = [0, 1, 2, 3, 4, 5, 6].map((weekday) =>
  weekday === 5 ? { weekday, isOff: true, startTime: null, endTime: null } : weekday === 6 ? { weekday, isOff: false, startTime: null, endTime: null } : { weekday, isOff: false, startTime: "09:00", endTime: "17:00" },
);
const FRIDAY = "2030-03-15";
const SATURDAY = "2030-03-16";

let admin: User, manager: User, sales: User, otherSales: User, tech: User, tech2: User, store: User;
let statuses: Awaited<ReturnType<typeof seedStatuses>>;
beforeEach(async () => {
  await resetDb();
  statuses = await seedStatuses();
  admin = await makeUser("ADMIN");
  manager = await makeUser("INSTALLATION_MANAGER", { name: "Ines Manager" });
  sales = await makeUser("SALES", { name: "Sara Sales" });
  otherSales = await makeUser("SALES", { name: "Omar Sales" });
  tech = await makeUser("TECHNICIAN", { name: "Hany Tech" });
  tech2 = await makeUser("TECHNICIAN", { name: "Karim Tech" });
  store = await makeUser("STORE");
});

describe("working hours", () => {
  it("are set by a scheduling manager only, validated, updated in place and audited", async () => {
    await expect(setWorkHours(asCurrent(tech), tech.id, { days: WEEK })).rejects.toBeInstanceOf(ForbiddenError);
    await expect(setWorkHours(asCurrent(sales), tech.id, { days: WEEK })).rejects.toBeInstanceOf(ForbiddenError);
    const bad = WEEK.map((d) => (d.weekday === 1 ? { ...d, startTime: "17:00", endTime: "09:00" } : d));
    await expect(setWorkHours(asCurrent(manager), tech.id, { days: bad })).rejects.toMatchObject({ fieldErrors: { "days.1.endTime": expect.stringMatching(/after the start/) } });
    await expect(setWorkHours(asCurrent(manager), tech.id, { days: WEEK.slice(0, 6) })).rejects.toBeInstanceOf(ValidationError);
    await expect(setWorkHours(asCurrent(manager), sales.id, { days: WEEK })).rejects.toBeInstanceOf(NotFoundError);

    expect(await setWorkHours(asCurrent(manager), tech.id, { days: WEEK, reason: "summer timetable" })).toEqual({ changed: 7 });
    const listed = (await listWorkHours()).find((r) => r.id === tech.id)!;
    expect(listed).toMatchObject({ configured: true, updatedBy: "Ines Manager" });
    expect(listed.days[5]).toMatchObject({ isOff: true });
    expect((await listWorkHours()).find((r) => r.id === tech2.id)).toMatchObject({ configured: false });

    // Changing Monday only: the same rows are updated (never deleted) and the audit names the change.
    const ids = (await prisma.technicianWorkHours.findMany({ where: { userId: tech.id }, orderBy: { weekday: "asc" } })).map((r) => r.id);
    expect(await setWorkHours(asCurrent(manager), tech.id, { days: WEEK.map((d) => (d.weekday === 1 ? { ...d, startTime: "10:00" } : d)) })).toEqual({ changed: 1 });
    expect((await prisma.technicianWorkHours.findMany({ where: { userId: tech.id }, orderBy: { weekday: "asc" } })).map((r) => r.id)).toEqual(ids);
    const audits = await prisma.auditLog.findMany({ where: { entityId: tech.id, action: "WORK_HOURS_UPDATED" }, orderBy: { createdAt: "asc" } });
    expect(audits).toHaveLength(2);
    expect(audits[0]!.reason).toBe("summer timetable");
    expect(audits[1]!.changes).toEqual({ weekday1: { from: "09:00-17:00", to: "10:00-17:00" } });
    // The database refuses an impossible row whatever the code does.
    await expect(prisma.technicianWorkHours.update({ where: { id: ids[2]! }, data: { isOff: true, startTime: "09:00", endTime: "10:00" } })).rejects.toThrow(/technician_work_hours_times_check/);
  });
});

describe("booking against working hours, and overrides", () => {
  beforeEach(async () => {
    await setWorkHours(asCurrent(manager), tech.id, { days: WEEK });
  });

  it("refuses a booking outside the technician's hours or on their day off; technicians without hours are not restricted", async () => {
    await expect(createAppointment(asCurrent(sales), appointmentPayload({ date: SUNDAY, startTime: "16:00", durationMinutes: 120, technicianIds: [tech.id] }))).rejects.toThrow(/Hany Tech works 09:00–17:00 on Sunday/);
    await expect(createAppointment(asCurrent(sales), appointmentPayload({ date: SUNDAY, startTime: "08:00", durationMinutes: 60, technicianIds: [tech.id] }))).rejects.toThrow(/works 09:00–17:00/);
    await expect(createAppointment(asCurrent(sales), appointmentPayload({ date: FRIDAY, technicianIds: [tech.id] }))).rejects.toThrow(/Friday is Hany Tech's day off/);
    // Inside the hours, on a working day without set hours, and a technician with no hours at all.
    expect((await createAppointment(asCurrent(sales), appointmentPayload({ date: SUNDAY, startTime: "15:00", durationMinutes: 120, technicianIds: [tech.id] }))).id).toBeTruthy();
    expect((await createAppointment(asCurrent(sales), appointmentPayload({ date: SATURDAY, startTime: "21:00", durationMinutes: 60, technicianIds: [tech.id] }))).id).toBeTruthy();
    expect((await createAppointment(asCurrent(sales), appointmentPayload({ date: FRIDAY, startTime: "22:00", durationMinutes: 60, technicianIds: [tech2.id] }))).id).toBeTruthy();
    // A booking without technicians is not restricted.
    expect((await createAppointment(asCurrent(sales), appointmentPayload({ date: FRIDAY }))).id).toBeTruthy();
  });

  it("lets a scheduling manager override soft rules with a reason, recorded in the audit log; Sales cannot override", async () => {
    const outside = appointmentPayload({ date: SUNDAY, startTime: "18:00", durationMinutes: 60, technicianIds: [tech.id] });
    await expect(createAppointment(asCurrent(sales), { ...outside, overrideReason: "customer only free after work" })).rejects.toThrow(/works 09:00–17:00/);
    const noReason = await createAppointment(asCurrent(manager), outside).catch((e: unknown) => e);
    expect(noReason).toBeInstanceOf(ValidationError);
    expect((noReason as ValidationError).fieldErrors).toMatchObject({ technicianIds: expect.stringMatching(/works 09:00–17:00/), overrideReason: expect.stringMatching(/reason for overriding/) });

    const booked = await createAppointment(asCurrent(manager), { ...outside, overrideReason: "customer only free after work" });
    const audit = await prisma.auditLog.findFirstOrThrow({ where: { entityId: booked.id, action: "APPOINTMENT_CREATED" } });
    expect(audit.changes).toMatchObject({ overrides: { rules: ["outsideHours"], reason: "customer only free after work" } });
    expect(audit.reason).toBe("customer only free after work");
    expect(audit.actorId).toBe(manager.id);

    // Moving it onto the day off is a new override; the reason goes into the update's audit entry.
    await expect(updateAppointment(asCurrent(manager), booked.id, { ...outside, date: FRIDAY, version: booked.version })).rejects.toThrow(/day off/);
    const moved = await updateAppointment(asCurrent(manager), booked.id, { ...outside, date: FRIDAY, version: booked.version, overrideReason: "moved at customer's request" });
    const upd = await prisma.auditLog.findFirstOrThrow({ where: { entityId: booked.id, action: { not: "APPOINTMENT_CREATED" }, reason: "moved at customer's request" } });
    expect(upd.changes).toMatchObject({ overrides: { rules: ["dayOff"], reason: "moved at customer's request" } });
    // Editing something else on it later needs no new override (the time did not change).
    expect((await updateAppointment(asCurrent(manager), moved.id, { ...outside, date: FRIDAY, brand: "Nuki", version: moved.version })).brand).toBe("Nuki");
  });

  it("never overrides the hard rules: overlapping visits and approved leave", async () => {
    await createAppointment(asCurrent(sales), appointmentPayload({ date: MONDAY, startTime: "10:00", durationMinutes: 120, technicianIds: [tech.id] }));
    await expect(createAppointment(asCurrent(manager), appointmentPayload({ date: MONDAY, startTime: "11:00", durationMinutes: 60, technicianIds: [tech.id], overrideReason: "urgent" }))).rejects.toBeInstanceOf(SchedulingConflictError);
    await createLeave(asCurrent(admin), { userId: tech2.id, startDate: MONDAY, endDate: MONDAY, type: "LEAVE" });
    await expect(createAppointment(asCurrent(manager), appointmentPayload({ date: MONDAY, startTime: "13:00", technicianIds: [tech2.id], overrideReason: "urgent" }))).rejects.toThrow(/leave/i);
    // Invalid times are refused before any rule.
    await expect(createAppointment(asCurrent(manager), appointmentPayload({ date: "2030-02-30", technicianIds: [tech.id], overrideReason: "x" }))).rejects.toBeInstanceOf(ValidationError);
    await expect(createAppointment(asCurrent(manager), appointmentPayload({ date: MONDAY, durationMinutes: 5, technicianIds: [tech.id], overrideReason: "x" }))).rejects.toBeInstanceOf(ValidationError);
  });

  it("shows a day off or time outside the hours in the booking form's availability", async () => {
    const startsAt = zonedToUtc(SUNDAY, "16:30", tz);
    const list = await technicianAvailability(prisma, { startsAt, endsAt: computeEnd(startsAt, 60), timezone: tz });
    expect(list.find((x) => x.id === tech.id)).toMatchObject({ available: true, offHours: "outsideHours" });
    expect(list.find((x) => x.id === tech2.id)).toMatchObject({ available: true, offHours: null });
    const fri = zonedToUtc(FRIDAY, "10:00", tz);
    expect((await workingHoursViolations(prisma, [tech.id], fri, computeEnd(fri, 60), tz))[0]).toMatchObject({ rule: "dayOff" });
    // A visit running past midnight is checked on both days.
    const late = zonedToUtc(SATURDAY, "23:00", tz);
    expect((await workingHoursViolations(prisma, [tech.id], late, computeEnd(late, 180), tz))[0]).toMatchObject({ rule: "outsideHours" });
  });

  it("books removal jobs like any other visit type", async () => {
    const r = await createAppointment(asCurrent(sales), appointmentPayload({ date: MONDAY, startTime: "09:00", visitType: "REMOVAL", technicianIds: [tech.id] }));
    expect((await getAppointment(asCurrent(tech), r.id)).visitType).toBe("REMOVAL");
  });
});

describe("company schedule", () => {
  it("shows everyone's time to readers, but customer details only on visits they may open", async () => {
    await setWorkHours(asCurrent(manager), tech.id, { days: WEEK });
    const mine = await createAppointment(asCurrent(sales), appointmentPayload({ date: MONDAY, startTime: "09:00", durationMinutes: 120, technicianIds: [tech.id], customer: { name: "Mona Mine", phone: "+20 100 000 0001" } }));
    const theirs = await createAppointment(asCurrent(otherSales), appointmentPayload({ date: MONDAY, startTime: "12:00", durationMinutes: 60, technicianIds: [tech2.id], visitType: "MAINTENANCE", customer: { name: "Tarek Theirs", phone: "+20 100 000 0002" } }));
    await createLeave(asCurrent(admin), { userId: tech2.id, startDate: "2030-03-12", endDate: "2030-03-12", type: "SICK" });

    // The technician: both visits' times, the customer only on their own.
    const t1 = await companySchedule(asCurrent(tech), { view: "day", date: MONDAY });
    expect(t1.technicians.map((x) => x.name)).toEqual(["Hany Tech", "Karim Tech"]);
    expect(t1.jobs[mine.id]).toMatchObject({ visible: true, customerName: "Mona Mine", time: "09:00–11:00" });
    expect(t1.jobs[theirs.id]).toMatchObject({ visible: false, customerName: null, code: null, area: null, visitType: "MAINTENANCE", time: "12:00–13:00" });
    expect(JSON.stringify(t1)).not.toContain("Tarek");
    expect(JSON.stringify(t1)).not.toContain("+20 100");
    const hany = t1.technicians[0]!.days[MONDAY]!;
    expect(hany).toMatchObject({ bookedMinutes: 120, capacityMinutes: 480, hours: { startTime: "09:00", endTime: "17:00" } });

    // Visibility follows the reader's appointment scope: Sales see all bookings by default, so all
    // customers; with their scope narrowed to their own bookings, only those.
    const s1 = await companySchedule(asCurrent(otherSales), { view: "day", date: MONDAY });
    expect(s1.jobs[theirs.id]!.visible && s1.jobs[mine.id]!.visible).toBe(true);
    const ownOnly = { ...asCurrent(otherSales), scopes: { ...asCurrent(otherSales).scopes, appointments: "OWN" as const } };
    const s2 = await companySchedule(ownOnly, { view: "day", date: MONDAY });
    expect(s2.jobs[theirs.id]!.visible).toBe(true);
    expect(s2.jobs[mine.id]).toMatchObject({ visible: false, customerName: null });
    const m1 = await companySchedule(asCurrent(manager), { view: "day", date: MONDAY });
    expect(m1.jobs[mine.id]!.visible && m1.jobs[theirs.id]!.visible).toBe(true);

    // Week view: leave, days off and the availability counts.
    const w = await companySchedule(asCurrent(tech), { view: "week", date: MONDAY });
    expect(w.days).toHaveLength(7);
    expect(w.technicians[1]!.days["2030-03-12"]).toMatchObject({ leave: "SICK", capacityMinutes: 0 });
    expect(w.technicians[0]!.days[FRIDAY]).toMatchObject({ hours: { isOff: true } });
    expect(w.availability[FRIDAY]).toMatchObject({ off: 1, free: 1 });
    expect(w.availability[MONDAY]).toMatchObject({ partial: 2, free: 0 });

    // Month view and filters (unknown filter values are ignored).
    const month = await companySchedule(asCurrent(tech), { view: "month", date: MONDAY });
    expect(month.from).toBe("2030-03-01");
    expect(month.to).toBe("2030-03-31");
    const filtered = await companySchedule(asCurrent(tech), { view: "day", date: MONDAY, visitType: "MAINTENANCE" });
    expect(Object.keys(filtered.jobs)).toEqual([theirs.id]);
    expect(Object.keys((await companySchedule(asCurrent(tech), { view: "day", date: MONDAY, visitType: "DROP TABLE" })).jobs)).toHaveLength(2);
    expect((await companySchedule(asCurrent(tech), { view: "day", date: MONDAY, technicianId: tech2.id })).technicians.map((x) => x.id)).toEqual([tech2.id]);
    // A cancelled visit does not take time.
    await updateAppointment(asCurrent(otherSales), theirs.id, appointmentPayload({ date: MONDAY, startTime: "12:00", durationMinutes: 60, technicianIds: [tech2.id], visitType: "MAINTENANCE", customer: { name: "Tarek Theirs", phone: "+20 100 000 0002" }, statusId: statuses.CANCELLED, version: theirs.version }));
    expect((await companySchedule(asCurrent(tech), { view: "day", date: MONDAY })).jobs[theirs.id]).toBeUndefined();

    // A company closed day is off for technicians without set hours that day (a working day "with
    // no set hours" included), but not for one whose hours that day are set.
    await setWorkHours(asCurrent(manager), tech2.id, { days: WEEK.map((d) => ({ ...d, isOff: false, startTime: d.weekday === 6 ? "10:00" : null, endTime: d.weekday === 6 ? "14:00" : null })) });
    const closed = await companySchedule(asCurrent(tech, { closedWeekdays: [5, 6] }), { view: "week", date: MONDAY });
    expect(closed.technicians[1]!.days[FRIDAY]).toMatchObject({ closed: true, capacityMinutes: 0 });
    expect(closed.technicians[1]!.days["2030-03-09"]).toMatchObject({ closed: true, capacityMinutes: 240 });

    // People without schedule.global cannot read it.
    await expect(companySchedule(asCurrent(store), { view: "day", date: MONDAY })).rejects.toBeInstanceOf(ForbiddenError);
  });
});

describe("reschedule requests", () => {
  it("lets the assigned technician ask; the booker or a manager answers; everyone involved is told; nothing is deleted", async () => {
    const a = await createAppointment(asCurrent(sales), appointmentPayload({ date: MONDAY, startTime: "10:00", technicianIds: [tech.id] }));
    await expect(requestReschedule(asCurrent(tech2), a.id, { reason: "not mine" })).rejects.toBeInstanceOf(NotFoundError);
    await expect(requestReschedule(asCurrent(sales), a.id, { reason: "x" })).rejects.toBeInstanceOf(ForbiddenError);
    await expect(requestReschedule(asCurrent(tech), a.id, { reason: "  " })).rejects.toBeInstanceOf(ValidationError);
    await expect(requestReschedule(asCurrent(tech), a.id, { reason: "x", proposedTime: "09:00" })).rejects.toMatchObject({ fieldErrors: { proposedDate: expect.any(String) } });

    const r = await requestReschedule(asCurrent(tech), a.id, { reason: "Part not delivered yet", proposedDate: "2030-03-13", proposedTime: "11:00" });
    expect(r).toMatchObject({ status: "OPEN", requestedBy: "Hany Tech", proposedStart: zonedToUtc("2030-03-13", "11:00", tz).toISOString() });
    await expect(requestReschedule(asCurrent(tech), a.id, { reason: "again" })).rejects.toThrow(/already an open reschedule request/);

    // The booker and the scheduling managers are told; the technician is not told about their own request.
    const told = async (u: User) => (await listNotifications(asCurrent(u))).items.some((n: { type: string }) => n.type === "RESCHEDULE_REQUESTED");
    expect(await told(sales)).toBe(true);
    expect(await told(manager)).toBe(true);
    expect(await told(admin)).toBe(true);
    expect(await told(tech)).toBe(false);
    expect(await told(otherSales)).toBe(false);
    expect((await openRescheduleRequests(asCurrent(manager))).map((x) => x.id)).toEqual([r.id]);
    expect(await openRescheduleRequests(asCurrent(tech))).toEqual([]);

    // Answering: technicians cannot; declining needs a note; an answer is final.
    await expect(resolveReschedule(asCurrent(tech), r.id, { status: "DONE" })).rejects.toBeInstanceOf(ForbiddenError);
    await expect(resolveReschedule(asCurrent(sales), r.id, { status: "DECLINED" })).rejects.toMatchObject({ fieldErrors: { note: expect.any(String) } });
    const done = await resolveReschedule(asCurrent(manager), r.id, { status: "DONE", note: "Moved to Wednesday" });
    expect(done).toMatchObject({ status: "DONE", resolvedBy: "Ines Manager", resolutionNote: "Moved to Wednesday" });
    await expect(resolveReschedule(asCurrent(sales), r.id, { status: "DECLINED", note: "no" })).rejects.toThrow(/already answered/);
    expect((await listNotifications(asCurrent(tech))).items.some((n: { type: string }) => n.type === "RESCHEDULE_RESOLVED")).toBe(true);

    // A new request can follow; history keeps both, with audit entries on the visit.
    const second = await requestReschedule(asCurrent(tech), a.id, { reason: "Customer travelling" });
    await resolveReschedule(asCurrent(sales), second.id, { status: "DECLINED", note: "Customer confirmed by phone" });
    expect((await visitRescheduleRequests(a.id)).map((x) => x.status)).toEqual(["DECLINED", "DONE"]);
    expect(await prisma.auditLog.count({ where: { appointmentId: a.id, action: { in: ["RESCHEDULE_REQUESTED", "RESCHEDULE_RESOLVED"] } } })).toBe(4);
    await expect(prisma.rescheduleRequest.delete({ where: { id: r.id } })).rejects.toThrow(/cannot be deleted/);

    // A completed visit cannot be asked about any more.
    const completed = await createAppointment(asCurrent(sales), appointmentPayload({ date: MONDAY, startTime: "15:00", technicianIds: [tech.id], statusId: statuses.COMPLETED }));
    await expect(requestReschedule(asCurrent(tech), completed.id, { reason: "late" })).rejects.toThrow(/cannot be rescheduled/);
  });
});
