import { beforeEach, describe, expect, it } from "vitest";
import type { User } from "@prisma/client";
import {
  calendarAppointments,
  cancelAppointment,
  changeAppointmentStatus,
  createAppointment,
  getAppointment,
  getAppointmentHistory,
  listAppointments,
  parseAppointmentFilters,
  updateAppointment,
} from "@/server/services/appointments";
import { createUser, listUsers } from "@/server/services/users";
import { updateSettings } from "@/server/services/settings";
import { buildReport } from "@/server/services/reports";
import { ForbiddenError, NotFoundError } from "@/server/errors";
import { appointmentPayload, asCurrent, makeUser, resetDb, seedStatuses } from "../helpers";

let statuses: Awaited<ReturnType<typeof seedStatuses>>;
let sales: User;
let techA: User;
let techB: User;
let apptA: string; // assigned to techA
let apptB: string; // assigned to techB

beforeEach(async () => {
  await resetDb();
  statuses = await seedStatuses();
  sales = await makeUser("SALES");
  techA = await makeUser("TECHNICIAN");
  techB = await makeUser("TECHNICIAN");
  apptA = (await createAppointment(asCurrent(sales), appointmentPayload({ technicianIds: [techA.id] }))).id;
  apptB = (await createAppointment(asCurrent(sales), appointmentPayload({ technicianIds: [techB.id], customer: { name: "Other Customer", phone: "01001112222" } }))).id;
});

const all = () => parseAppointmentFilters(new URLSearchParams());

describe("Technician access", () => {
  it("only lists and opens appointments assigned to them", async () => {
    const tech = asCurrent(techA);
    const list = await listAppointments(tech, all());
    expect(list.rows.map((r) => r.id)).toEqual([apptA]);
    const cal = await calendarAppointments(tech, { from: "2030-03-01", to: "2030-03-31" });
    expect(cal.map((r) => r.id)).toEqual([apptA]);
    expect((await getAppointment(tech, apptA)).id).toBe(apptA);
    // Guessing another technician's appointment ID looks exactly like a missing record.
    await expect(getAppointment(tech, apptB)).rejects.toBeInstanceOf(NotFoundError);
  });

  it("sees the address, map link and phone but not internal notes, and cannot manage", async () => {
    const dto = await getAppointment(asCurrent(techA), apptA);
    expect(dto.location?.apartment).toBe("14B");
    expect(dto.location?.link).toBeTruthy();
    expect(dto.customer.phone).toBeDefined();
    expect(dto.additionalNotes).toBe("Bring shoe covers");
    expect("internalNotes" in dto).toBe(false);
    expect(dto.canManage).toBe(false);
  });

  it("is strictly read-only", async () => {
    const tech = asCurrent(techA);
    await expect(createAppointment(tech, appointmentPayload())).rejects.toBeInstanceOf(ForbiddenError);
    await expect(updateAppointment(tech, apptA, appointmentPayload({ startTime: "15:00" }))).rejects.toBeInstanceOf(ForbiddenError);
    await expect(changeAppointmentStatus(tech, apptA, { statusId: statuses.COMPLETED })).rejects.toBeInstanceOf(ForbiddenError);
    await expect(cancelAppointment(tech, apptA, {})).rejects.toBeInstanceOf(ForbiddenError);
    await expect(getAppointmentHistory(tech, apptA)).rejects.toBeInstanceOf(ForbiddenError);
  });

  it("does not leak phone numbers when contact details are disabled in settings", async () => {
    const dto = await getAppointment(asCurrent(techA, { technicianCanSeeContacts: false }), apptA);
    expect(dto.customer.phone).toBeUndefined();
    expect(dto.customer.name).toBe("Test Customer");
  });
});

describe("Viewer access", () => {
  it("sees nothing without permissions", async () => {
    const viewer = asCurrent(await makeUser("VIEWER", { viewerPermissions: [] }));
    await expect(listAppointments(viewer, all())).rejects.toBeInstanceOf(ForbiddenError);
    await expect(getAppointment(viewer, apptA)).rejects.toBeInstanceOf(ForbiddenError);
  });

  it("gets read-only, redacted data according to the permissions an Admin granted", async () => {
    const viewer = asCurrent(await makeUser("VIEWER", { viewerPermissions: ["appointments.view"] }));
    const list = await listAppointments(viewer, all());
    expect(list.total).toBe(2);
    const dto = await getAppointment(viewer, apptA);
    expect(dto.location).toBeNull();
    expect(dto.customer.phone).toBeUndefined();
    expect("internalNotes" in dto).toBe(false);
    expect(dto.canManage).toBe(false);
    await expect(createAppointment(viewer, appointmentPayload())).rejects.toBeInstanceOf(ForbiddenError);
    await expect(cancelAppointment(viewer, apptA, {})).rejects.toBeInstanceOf(ForbiddenError);
    await expect(buildReport(viewer, { from: "2030-01-01", to: "2030-12-31" })).rejects.toBeInstanceOf(ForbiddenError);
  });

  it("cannot search by phone number unless allowed to see phone numbers", async () => {
    const viewer = asCurrent(await makeUser("VIEWER", { viewerPermissions: ["appointments.view"] }));
    const res = await listAppointments(viewer, parseAppointmentFilters(new URLSearchParams({ q: "1001112222" })));
    expect(res.total).toBe(0);
    const salesRes = await listAppointments(asCurrent(sales), parseAppointmentFilters(new URLSearchParams({ q: "1001112222" })));
    expect(salesRes.rows.map((r) => r.id)).toEqual([apptB]);
  });

  it("history hides fields the viewer may not see", async () => {
    await updateAppointment(asCurrent(sales), apptA, appointmentPayload({ technicianIds: [techA.id], internalNotes: "Secret change", floor: "4" }));
    const viewer = asCurrent(await makeUser("VIEWER", { viewerPermissions: ["appointments.view", "history.view"] }));
    const history = await getAppointmentHistory(viewer, apptA);
    const update = history.find((h) => h.action === "APPOINTMENT_UPDATED")!;
    expect(JSON.stringify(update.changes)).not.toContain("Secret change");
    expect((update.changes as Record<string, { to: unknown }>).internalNotes!.to).toBe("(hidden)");
  });
});

describe("Sales access", () => {
  it("sees all company appointments and can manage them", async () => {
    const s2 = asCurrent(await makeUser("SALES"));
    expect((await listAppointments(s2, all())).total).toBe(2);
    const dto = await getAppointment(s2, apptA);
    expect(dto.canManage).toBe(true);
    expect(dto.internalNotes).toBe("Deposit paid");
  });

  it("can be restricted to editing only their own appointments", async () => {
    const s2 = asCurrent(await makeUser("SALES"), { salesCanEditOthersAppointments: false });
    await expect(updateAppointment(s2, apptA, appointmentPayload({ technicianIds: [techA.id] }))).rejects.toBeInstanceOf(ForbiddenError);
  });

  it("cannot manage users or system settings", async () => {
    const s = asCurrent(sales);
    await expect(listUsers(s)).rejects.toBeInstanceOf(ForbiddenError);
    await expect(createUser(s, { name: "X", email: "x@test.local", role: "ADMIN" })).rejects.toBeInstanceOf(ForbiddenError);
    await expect(updateSettings(s, {})).rejects.toBeInstanceOf(ForbiddenError);
  });
});
