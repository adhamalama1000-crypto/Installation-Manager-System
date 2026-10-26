import { beforeEach, describe, expect, it } from "vitest";
import type { User } from "@prisma/client";
import { cancelAppointment, changeAppointmentStatus, createAppointment, updateAppointment } from "@/server/services/appointments";
import { dashboardSummary } from "@/server/services/dashboard";
import { cancelLeave, createLeave, decideLeave, leaveOverview } from "@/server/services/leaves";
import { listNotifications } from "@/server/services/notifications";
import { technicianAvailability } from "@/server/services/scheduling";
import { listAuditLog } from "@/server/services/audit-log";
import { ForbiddenError, NotFoundError, ValidationError } from "@/server/errors";
import { appointmentPayload, asCurrent, makeUser, prisma, resetDb, seedStatuses } from "../helpers";

let statuses: Awaited<ReturnType<typeof seedStatuses>>;
let admin: User, sales: User, tech: User, otherTech: User;
const NOW = new Date("2030-03-01T08:00:00Z");

beforeEach(async () => {
  await resetDb();
  statuses = await seedStatuses();
  admin = await makeUser("ADMIN");
  sales = await makeUser("SALES");
  tech = await makeUser("TECHNICIAN");
  otherTech = await makeUser("TECHNICIAN");
});

const leave = (overrides: Record<string, unknown> = {}) => ({ type: "LEAVE", startDate: "2030-03-10", endDate: "2030-03-11", reason: "Family wedding", ...overrides });

async function approvedLeave(overrides: Record<string, unknown> = {}) {
  return createLeave(asCurrent(admin), leave({ userId: tech.id, ...overrides }), NOW);
}

describe("asking for and deciding leave", () => {
  it("lets a technician ask, notifies the Admins, and records the decision", async () => {
    const { leave: requested, clashes } = await createLeave(asCurrent(tech), leave(), NOW);
    expect(requested).toMatchObject({ status: "REQUESTED", startDate: "2030-03-10", endDate: "2030-03-11", days: 2, canCancel: true, canDecide: false });
    expect(clashes).toEqual([]);
    expect((await listNotifications(asCurrent(admin))).items[0]).toMatchObject({ type: "LEAVE_REQUESTED" });

    const { leave: approved } = await decideLeave(asCurrent(admin), requested.id, { decision: "APPROVED", note: "Enjoy" }, NOW);
    expect(approved).toMatchObject({ status: "APPROVED", decisionNote: "Enjoy", decidedBy: { id: admin.id } });
    expect((await listNotifications(asCurrent(tech))).items[0]).toMatchObject({ type: "LEAVE_APPROVED" });
    await expect(decideLeave(asCurrent(admin), requested.id, { decision: "REJECTED" }, NOW)).rejects.toThrow(/already approved/);

    const audit = await listAuditLog(asCurrent(admin), { entityType: "LEAVE" });
    expect(audit.items.map((a) => a.action)).toEqual(["LEAVE_APPROVED", "LEAVE_REQUESTED"]);
    // Technicians only see their own leave; Admins see everyone's.
    expect((await leaveOverview(asCurrent(tech), NOW)).upcoming.map((l) => l.id)).toEqual([requested.id]);
    expect((await leaveOverview(asCurrent(otherTech), NOW)).upcoming).toEqual([]);
    expect((await leaveOverview(asCurrent(admin), NOW)).upcoming).toHaveLength(1);
  });

  it("validates dates, overlaps and who may ask", async () => {
    await expect(createLeave(asCurrent(tech), leave({ startDate: "2030-02-27", endDate: "2030-02-28" }), NOW)).rejects.toBeInstanceOf(ValidationError);
    await expect(createLeave(asCurrent(tech), leave({ endDate: "2030-03-09" }), NOW)).rejects.toBeInstanceOf(ValidationError);
    await expect(createLeave(asCurrent(tech), leave({ userId: otherTech.id }), NOW)).rejects.toBeInstanceOf(ForbiddenError);
    await expect(createLeave(asCurrent(sales), leave(), NOW)).rejects.toBeInstanceOf(ForbiddenError);
    await expect(createLeave(asCurrent(admin), leave({ userId: sales.id }), NOW)).rejects.toBeInstanceOf(ValidationError);
    await expect(createLeave(asCurrent(admin), leave(), NOW)).rejects.toBeInstanceOf(ValidationError); // no technician chosen

    await createLeave(asCurrent(tech), leave(), NOW);
    await expect(createLeave(asCurrent(tech), leave({ startDate: "2030-03-11", endDate: "2030-03-12" }), NOW)).rejects.toThrow(/overlaps a leave request/);
    // An Admin may record past absences.
    const past = await createLeave(asCurrent(admin), leave({ userId: tech.id, type: "ABSENCE", startDate: "2030-02-20", endDate: "2030-02-20" }), NOW);
    expect(past.leave.status).toBe("APPROVED");
  });

  it("lets the technician withdraw a request and the Admin end approved leave", async () => {
    const { leave: requested } = await createLeave(asCurrent(tech), leave(), NOW);
    await expect(cancelLeave(asCurrent(otherTech), requested.id, NOW)).rejects.toBeInstanceOf(NotFoundError);
    expect((await cancelLeave(asCurrent(tech), requested.id, NOW)).status).toBe("CANCELLED");
    await expect(cancelLeave(asCurrent(tech), requested.id, NOW)).rejects.toBeInstanceOf(ValidationError);

    const { leave: approved } = await approvedLeave();
    // The technician cannot cancel approved leave that has already ended.
    await expect(cancelLeave(asCurrent(tech), approved.id, new Date("2030-03-12T10:00:00Z"))).rejects.toThrow(/already ended/);
    expect((await cancelLeave(asCurrent(admin), approved.id, NOW)).status).toBe("CANCELLED");
    expect((await listNotifications(asCurrent(tech))).items[0]).toMatchObject({ type: "LEAVE_CANCELLED" });
    // Bookable again.
    expect((await createAppointment(asCurrent(sales), appointmentPayload({ technicianIds: [tech.id] }))).id).toBeTruthy();
  });
});

describe("approved leave blocks bookings", () => {
  it("refuses new bookings of the technician on those days and marks them in availability", async () => {
    await approvedLeave({ type: "SICK" });
    await expect(createAppointment(asCurrent(sales), appointmentPayload({ technicianIds: [tech.id] }))).rejects.toMatchObject({
      fieldErrors: { technicianIds: expect.stringContaining("sick leave") },
    });
    // Other technicians, other days and non-blocking statuses are fine.
    expect((await createAppointment(asCurrent(sales), appointmentPayload({ technicianIds: [otherTech.id] }))).id).toBeTruthy();
    expect((await createAppointment(asCurrent(sales), appointmentPayload({ technicianIds: [tech.id], date: "2030-03-12" }))).id).toBeTruthy();
    expect((await createAppointment(asCurrent(sales), appointmentPayload({ technicianIds: [tech.id], statusId: statuses.CANCELLED }))).id).toBeTruthy();
    // A pending request does not block yet.
    await createLeave(asCurrent(otherTech), leave({ startDate: "2030-03-20", endDate: "2030-03-20" }), NOW);
    expect((await createAppointment(asCurrent(sales), appointmentPayload({ technicianIds: [otherTech.id], date: "2030-03-20" }))).id).toBeTruthy();

    const availability = await technicianAvailability(prisma, {
      startsAt: new Date("2030-03-10T08:00:00Z"),
      endsAt: new Date("2030-03-10T09:00:00Z"),
      timezone: "Africa/Cairo",
    });
    expect(availability.find((t) => t.id === tech.id)).toMatchObject({ available: false, conflicts: [], leave: { type: "SICK", startDate: "2030-03-10", endDate: "2030-03-11" } });
    expect(availability.find((t) => t.id === otherTech.id)).toMatchObject({ leave: null });
  });

  it("uses company-local days, including visits that run past midnight into the leave", async () => {
    await approvedLeave({ startDate: "2030-03-10", endDate: "2030-03-10" });
    // 23:00 on the 9th for 2 hours ends at 01:00 local on the 10th.
    await expect(
      createAppointment(asCurrent(sales), appointmentPayload({ technicianIds: [tech.id], date: "2030-03-09", startTime: "23:00", durationMinutes: 120 })),
    ).rejects.toBeInstanceOf(ValidationError);
    // Ending exactly at local midnight does not touch the 10th.
    expect(
      (await createAppointment(asCurrent(sales), appointmentPayload({ technicianIds: [tech.id], date: "2030-03-09", startTime: "22:00", durationMinutes: 120 }))).id,
    ).toBeTruthy();
    // 00:30 local on the 11th is 22:30 UTC on the 10th: not on leave.
    expect((await createAppointment(asCurrent(sales), appointmentPayload({ technicianIds: [tech.id], date: "2030-03-11", startTime: "00:30", durationMinutes: 60 }))).id).toBeTruthy();
  });

  it("reports existing bookings when leave is approved and keeps them editable", async () => {
    const booked = await createAppointment(asCurrent(sales), appointmentPayload({ technicianIds: [tech.id] }));
    const { leave: requested } = await createLeave(asCurrent(tech), leave(), NOW);
    const { clashes } = await decideLeave(asCurrent(admin), requested.id, { decision: "APPROVED" }, NOW);
    expect(clashes.map((c) => c.appointmentId)).toEqual([booked.id]);
    expect((await listNotifications(asCurrent(sales))).items.find((n) => n.type === "LEAVE_CLASH")).toMatchObject({ appointmentId: booked.id });
    const summary = await dashboardSummary(asCurrent(sales), NOW);
    expect(summary.attention).toContainEqual(expect.objectContaining({ id: booked.id, reason: "dashboard.reasons.onLeave" }));

    // Same day, same technician: other details can still be edited.
    const edited = await updateAppointment(asCurrent(sales), booked.id, appointmentPayload({ technicianIds: [tech.id], version: booked.version, brand: "Samsung", startTime: "11:00" }));
    expect(edited.brand).toBe("Samsung");
    // Moving it to another leave day re-checks the technician.
    await expect(
      updateAppointment(asCurrent(sales), booked.id, appointmentPayload({ technicianIds: [tech.id], version: edited.version, date: "2030-03-11" })),
    ).rejects.toBeInstanceOf(ValidationError);
    // Reassigning clears the warning.
    const reassigned = await updateAppointment(asCurrent(sales), booked.id, appointmentPayload({ technicianIds: [otherTech.id], version: edited.version }));
    expect(reassigned.technicians.map((t) => t.id)).toEqual([otherTech.id]);
    const after = await dashboardSummary(asCurrent(sales), NOW);
    expect(after.attention.map((a) => a.id)).not.toContain(booked.id);
  });

  it("does not let an Admin approve leave over another approved leave, nor re-open a cancelled booking on leave", async () => {
    const booked = await createAppointment(asCurrent(sales), appointmentPayload({ technicianIds: [tech.id] }));
    const cancelled = await cancelAppointment(asCurrent(sales), booked.id, {});
    await approvedLeave();
    await expect(changeAppointmentStatus(asCurrent(sales), booked.id, { statusId: statuses.SCHEDULED, version: cancelled.version })).rejects.toBeInstanceOf(
      ValidationError,
    );
    await expect(approvedLeave({ startDate: "2030-03-11", endDate: "2030-03-13" })).rejects.toThrow(/overlaps approved leave/);
  });
});
