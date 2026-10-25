import { beforeEach, describe, expect, it } from "vitest";
import type { User } from "@prisma/client";
import {
  createAppointment,
  getAppointment,
  getAppointmentHistory,
  listAppointments,
  parseAppointmentFilters,
  setCustomerConfirmation,
  updateAppointment,
} from "@/server/services/appointments";
import { dashboardSummary } from "@/server/services/dashboard";
import { DEFAULT_SETTINGS, updateSettings } from "@/server/services/settings";
import { ForbiddenError, StaleRecordError, ValidationError } from "@/server/errors";
import { appointmentPayload, asCurrent, makeUser, prisma, resetDb, seedStatuses } from "../helpers";

let statuses: Awaited<ReturnType<typeof seedStatuses>>;
let admin: User, sales: User, tech: User, otherTech: User;

beforeEach(async () => {
  await resetDb();
  statuses = await seedStatuses();
  admin = await makeUser("ADMIN");
  sales = await makeUser("SALES");
  tech = await makeUser("TECHNICIAN");
  otherTech = await makeUser("TECHNICIAN");
});

const FRIDAY = "2030-03-15";

describe("visit type and customer confirmation", () => {
  it("stores the visit type, starts unconfirmed, and audits changes", async () => {
    const a = await createAppointment(asCurrent(sales), appointmentPayload({ visitType: "MAINTENANCE" }));
    expect(a.visitType).toBe("MAINTENANCE");
    expect(a.customerConfirmation).toBe("PENDING");
    const list = await listAppointments(asCurrent(sales), parseAppointmentFilters({}));
    expect(list.rows[0]).toMatchObject({ visitType: "MAINTENANCE", customerConfirmation: "PENDING" });

    const edited = await updateAppointment(asCurrent(sales), a.id, appointmentPayload({ visitType: "INSPECTION", version: a.version }));
    expect(edited.visitType).toBe("INSPECTION");
    const history = await getAppointmentHistory(asCurrent(sales), a.id);
    expect(history.find((h) => h.action === "APPOINTMENT_UPDATED")?.changes).toMatchObject({ visitType: { from: "MAINTENANCE", to: "INSPECTION" } });
  });

  it("keeps old appointments valid without a visit type", async () => {
    const a = await createAppointment(asCurrent(sales), appointmentPayload({ visitType: "" }));
    expect(a.visitType).toBeNull();
  });

  it("records the customer's confirmation with optimistic locking and an audit entry", async () => {
    const a = await createAppointment(asCurrent(sales), appointmentPayload({ technicianIds: [tech.id] }));
    const confirmed = await setCustomerConfirmation(asCurrent(sales), a.id, { confirmation: "CONFIRMED", version: a.version });
    expect(confirmed.customerConfirmation).toBe("CONFIRMED");
    expect(confirmed.version).toBe(a.version + 1);
    await expect(setCustomerConfirmation(asCurrent(sales), a.id, { confirmation: "UNREACHABLE", version: a.version })).rejects.toBeInstanceOf(StaleRecordError);
    await expect(setCustomerConfirmation(asCurrent(tech), a.id, { confirmation: "UNREACHABLE" })).rejects.toBeInstanceOf(ForbiddenError);
    const history = await getAppointmentHistory(asCurrent(sales), a.id);
    expect(history[0]).toMatchObject({ action: "CONFIRMATION_CHANGED", changes: { customerConfirmation: { from: "PENDING", to: "CONFIRMED" } } });
    // An edit that does not send the field keeps it.
    const edited = await updateAppointment(asCurrent(sales), a.id, appointmentPayload({ version: confirmed.version, technicianIds: [tech.id] }));
    expect(edited.customerConfirmation).toBe("CONFIRMED");
  });

  it("flags today's and tomorrow's unconfirmed visits on the dashboard", async () => {
    const now = new Date("2030-03-09T08:00:00Z"); // Saturday 10:00 in Cairo
    const tomorrow = await createAppointment(asCurrent(sales), appointmentPayload({ technicianIds: [tech.id], date: "2030-03-10", startTime: "10:00" }));
    const later = await createAppointment(asCurrent(sales), appointmentPayload({ technicianIds: [tech.id], date: "2030-03-12", startTime: "10:00" }));
    const confirmed = await createAppointment(asCurrent(sales), appointmentPayload({ technicianIds: [otherTech.id], date: "2030-03-10", startTime: "12:00", customerConfirmation: "CONFIRMED" }));
    const summary = await dashboardSummary(asCurrent(sales), now);
    const flagged = summary.attention.filter((x) => x.reason.startsWith("Customer has not confirmed")).map((x) => x.id);
    expect(flagged).toEqual([tomorrow.id]);
    expect(flagged).not.toContain(later.id);
    expect(flagged).not.toContain(confirmed.id);
  });
});

describe("closed weekdays", () => {
  beforeEach(async () => {
    await updateSettings(asCurrent(admin), { ...DEFAULT_SETTINGS, closedWeekdays: [5] });
  });

  it("refuses bookings on a closed day, except an Admin who explicitly allows it", async () => {
    await expect(createAppointment(asCurrent(sales), appointmentPayload({ date: FRIDAY }))).rejects.toBeInstanceOf(ValidationError);
    await expect(createAppointment(asCurrent(sales), appointmentPayload({ date: FRIDAY, allowClosedDay: true }))).rejects.toBeInstanceOf(ValidationError);
    await expect(createAppointment(asCurrent(admin), appointmentPayload({ date: FRIDAY }))).rejects.toBeInstanceOf(ValidationError);
    const forced = await createAppointment(asCurrent(admin), appointmentPayload({ date: FRIDAY, allowClosedDay: true }));
    expect(forced.id).toBeTruthy();
    // A status that does not block the schedule (e.g. cancelled) is not a booking.
    expect((await createAppointment(asCurrent(sales), appointmentPayload({ date: FRIDAY, statusId: statuses.CANCELLED }))).id).toBeTruthy();
  });

  it("only checks the rule when an appointment is moved onto a closed day", async () => {
    const a = await createAppointment(asCurrent(sales), appointmentPayload({ date: "2030-03-14" }));
    await expect(updateAppointment(asCurrent(sales), a.id, appointmentPayload({ date: FRIDAY, version: a.version }))).rejects.toBeInstanceOf(ValidationError);
    // An existing booking on a day that became closed can still be edited.
    await updateSettings(asCurrent(admin), { ...DEFAULT_SETTINGS, closedWeekdays: [] });
    const onFriday = await createAppointment(asCurrent(sales), appointmentPayload({ date: FRIDAY }));
    await updateSettings(asCurrent(admin), { ...DEFAULT_SETTINGS, closedWeekdays: [5] });
    const edited = await updateAppointment(asCurrent(sales), onFriday.id, appointmentPayload({ date: FRIDAY, version: onFriday.version, brand: "Samsung" }));
    expect(edited.brand).toBe("Samsung");
  });

  it("validates the setting", async () => {
    await expect(updateSettings(asCurrent(admin), { ...DEFAULT_SETTINGS, closedWeekdays: [0, 1, 2, 3, 4, 5, 6] })).rejects.toBeInstanceOf(ValidationError);
    await expect(updateSettings(asCurrent(admin), { ...DEFAULT_SETTINGS, closedWeekdays: [5, 5] })).rejects.toBeInstanceOf(ValidationError);
  });
});

describe("follow-up visits", () => {
  it("links a follow-up to the earlier visit in both directions, scoped for technicians", async () => {
    const first = await createAppointment(asCurrent(sales), appointmentPayload({ technicianIds: [tech.id] }));
    const second = await createAppointment(asCurrent(sales), appointmentPayload({ followUpOfId: first.id, date: "2030-03-20", technicianIds: [otherTech.id] }));
    expect(second.followUpOf).toEqual({ id: first.id, code: first.code });
    const reloaded = await getAppointment(asCurrent(sales), first.id);
    expect(reloaded.followUps.map((f) => f.id)).toEqual([second.id]);
    // The technician of the first visit cannot see the follow-up assigned to someone else.
    expect((await getAppointment(asCurrent(tech), first.id)).followUps).toEqual([]);
    // The link is set at creation and survives edits.
    const edited = await updateAppointment(asCurrent(sales), second.id, appointmentPayload({ version: second.version, date: "2030-03-21", technicianIds: [otherTech.id] }));
    expect(edited.followUpOf?.id).toBe(first.id);
  });

  it("rejects a follow-up of an appointment that does not exist", async () => {
    await expect(createAppointment(asCurrent(sales), appointmentPayload({ followUpOfId: "missing" }))).rejects.toBeInstanceOf(ValidationError);
    expect(await prisma.appointment.count()).toBe(0);
  });
});
