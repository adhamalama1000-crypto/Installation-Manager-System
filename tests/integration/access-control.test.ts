import { beforeEach, describe, expect, it } from "vitest";
import type { User } from "@prisma/client";
import { cancelAppointment, createAppointment, getAppointment, listAppointments, parseAppointmentFilters, updateAppointment } from "@/server/services/appointments";
import { getUserAccess, saveTeam, setUserAccess } from "@/server/services/access-control";
import { recordAudit } from "@/server/services/audit";
import { listAuditLog, recordCorrection } from "@/server/services/audit-log";
import { getCustomer, listCustomers } from "@/server/services/customers";
import { listExpenses } from "@/server/services/expenses";
import { recordCheckIn } from "@/server/services/field";
import { createLeave, decideLeave } from "@/server/services/leaves";
import { updateUser } from "@/server/services/users";
import { ForbiddenError, NotFoundError, ValidationError } from "@/server/errors";
import { roleDefaults } from "@/lib/permissions";
import { DEFAULT_SETTINGS } from "@/server/services/settings";
import { appointmentPayload, asCurrent, makeUser, prisma, resetDb, seedStatuses } from "../helpers";

/**
 * Per-person permissions, data scopes and teams, enforced on the server, and the audit trail of
 * every change. Uses the service functions directly (the API-level checks are in access-api.test.ts).
 */
let admin: User, admin2: User, sara: User, omar: User, tech: User, tech2: User, accountant: User, viewer: User;
const fresh = async (u: User) => asCurrent(await prisma.user.findUniqueOrThrow({ where: { id: u.id } }));
const filters = parseAppointmentFilters({});
let day = 0;
const book = async (by: User, techs: User[] = [], extra: Record<string, unknown> = {}) =>
  createAppointment(asCurrent(by), appointmentPayload({ technicianIds: techs.map((t) => t.id), date: `2031-0${1 + (day % 9)}-${String(10 + (day++ % 18)).padStart(2, "0")}`, ...extra }));

beforeEach(async () => {
  await resetDb();
  await seedStatuses();
  day = 0;
  admin = await makeUser("ADMIN", { name: "Adel Admin" });
  admin2 = await makeUser("ADMIN", { name: "Basma Admin" });
  sara = await makeUser("SALES", { name: "Sara Sales" });
  omar = await makeUser("SALES", { name: "Omar Sales" });
  tech = await makeUser("TECHNICIAN", { name: "Karim Tech" });
  tech2 = await makeUser("TECHNICIAN", { name: "Youssef Tech" });
  accountant = await makeUser("ACCOUNTANT", { name: "Nadia Accounts" });
  viewer = await makeUser("VIEWER", { name: "Laila Viewer", viewerPermissions: ["appointments.view"] });
});

const defaults = (role: User["role"]) => [...roleDefaults({ role }, DEFAULT_SETTINGS)];

describe("managing access", () => {
  it("only an Admin manages access; nobody changes their own; Admins cannot be restricted", async () => {
    await expect(getUserAccess(asCurrent(sara), omar.id)).rejects.toBeInstanceOf(ForbiddenError);
    await expect(setUserAccess(asCurrent(sara), omar.id, { mode: "reset" })).rejects.toBeInstanceOf(ForbiddenError);
    await expect(setUserAccess(asCurrent(sara), sara.id, { mode: "set", permissions: [...defaults("SALES"), "leaves.manage"] })).rejects.toBeInstanceOf(ForbiddenError);
    await expect(setUserAccess(asCurrent(admin), admin.id, { mode: "reset" })).rejects.toMatchObject({ message: expect.any(String) });
    await expect(setUserAccess(asCurrent(admin), admin.id, { mode: "reset" })).rejects.toBeInstanceOf(ForbiddenError);
    await expect(setUserAccess(asCurrent(admin), admin2.id, { mode: "set", permissions: [] })).rejects.toBeInstanceOf(ValidationError);
    expect((await getUserAccess(asCurrent(admin), admin2.id)).isAdmin).toBe(true);
  });

  it("never grants Admin-only permissions, and keeps Viewers read-only", async () => {
    await expect(setUserAccess(asCurrent(admin), sara.id, { mode: "set", permissions: [...defaults("SALES"), "users.manage"] })).rejects.toMatchObject({ rawFieldErrors: { _form: expect.stringContaining("users.manage") } });
    await expect(setUserAccess(asCurrent(admin), viewer.id, { mode: "set", permissions: ["appointments.view", "appointments.manage"] })).rejects.toBeInstanceOf(ValidationError);
    const u = await prisma.user.findUniqueOrThrow({ where: { id: sara.id } });
    expect([u.permissionGrants, u.permissionDenies]).toEqual([[], []]);
    // A viewer can be given more to read.
    await setUserAccess(asCurrent(admin), viewer.id, { mode: "set", permissions: ["appointments.view", "customers.view", "reports.view"] });
    expect((await fresh(viewer)).permissions).toEqual(expect.arrayContaining(["customers.view", "reports.view"]));
    // Even if Admin-only permissions were written straight into the database, they would not apply.
    await prisma.user.update({ where: { id: omar.id }, data: { permissionGrants: ["users.manage", "audit.view"] } });
    expect((await fresh(omar)).permissions).not.toContain("users.manage");
  });

  it("stores only the difference from the role, and audits old and new values with the reason", async () => {
    const team = await saveTeam(asCurrent(admin), null, { name: "North" });
    const wanted = defaults("SALES").filter((p) => p !== "appointments.cancel").concat("leaves.manage");
    const r = await setUserAccess(asCurrent(admin), sara.id, { mode: "set", permissions: wanted, scopes: { appointments: "OWN" }, teamId: team.id, reason: "Covers leave approvals" });
    expect(r).toMatchObject({ changed: true, added: ["leaves.manage"], removed: ["appointments.cancel"] });
    const u = await prisma.user.findUniqueOrThrow({ where: { id: sara.id } });
    expect([u.permissionGrants, u.permissionDenies, u.dataScopes, u.teamId]).toEqual([["leaves.manage"], ["appointments.cancel"], { appointments: "OWN" }, team.id]);
    const me = await fresh(sara);
    expect(me.permissions).toContain("leaves.manage");
    expect(me.permissions).not.toContain("appointments.cancel");
    expect(me.scopes.appointments).toBe("OWN");

    const entry = await prisma.auditLog.findFirstOrThrow({ where: { action: "USER_ACCESS_CHANGED" } });
    expect(entry).toMatchObject({ module: "users", entityId: sara.id, actorId: admin.id, reason: "Covers leave approvals" });
    expect(entry.changes).toMatchObject({ mode: "set", permissionsAdded: ["leaves.manage"], permissionsRemoved: ["appointments.cancel"], scopes: { appointments: { from: "ALL", to: "OWN" } }, teamId: { from: null, to: team.id } });
    // Saving the same thing again changes nothing and writes nothing.
    expect(await setUserAccess(asCurrent(admin), sara.id, { mode: "set", permissions: wanted, scopes: { appointments: "OWN" }, teamId: team.id })).toEqual({ changed: false });
    expect(await prisma.auditLog.count({ where: { action: "USER_ACCESS_CHANGED" } })).toBe(1);
  });

  it("copies another person's access, applies templates, resets, and starts over on a role change", async () => {
    await setUserAccess(asCurrent(admin), sara.id, { mode: "set", permissions: [...defaults("SALES"), "board.view"], scopes: { customers: "OWN" } });
    await setUserAccess(asCurrent(admin), omar.id, { mode: "copy", fromUserId: sara.id });
    const copied = await fresh(omar);
    expect(copied.permissions.sort()).toEqual((await fresh(sara)).permissions.sort());
    expect(copied.scopes.customers).toBe("OWN");

    await setUserAccess(asCurrent(admin), omar.id, { mode: "template", template: "salesOwnRecords" });
    expect((await fresh(omar)).scopes).toMatchObject({ appointments: "OWN", customers: "OWN", sales: "OWN" });

    await setUserAccess(asCurrent(admin), omar.id, { mode: "reset" });
    const reset = await prisma.user.findUniqueOrThrow({ where: { id: omar.id } });
    expect([reset.permissionGrants, reset.permissionDenies, reset.dataScopes]).toEqual([[], [], null]);
    expect(await prisma.auditLog.count({ where: { action: "USER_ACCESS_CHANGED", entityId: omar.id } })).toBe(3);

    await updateUser(asCurrent(admin), sara.id, { role: "ACCOUNTANT" });
    const changed = await prisma.user.findUniqueOrThrow({ where: { id: sara.id } });
    expect([changed.permissionGrants, changed.dataScopes]).toEqual([[], null]);
  });
});

describe("actions are checked on the server", () => {
  it("a view-only person cannot create, edit or cancel bookings", async () => {
    const a = await book(omar);
    await setUserAccess(asCurrent(admin), sara.id, { mode: "set", permissions: defaults("SALES").filter((p) => !["appointments.create", "appointments.manage", "appointments.cancel", "appointments.assign"].includes(p)) });
    const s = await fresh(sara);
    expect((await getAppointment(s, a.id)).id).toBe(a.id);
    await expect(createAppointment(s, appointmentPayload())).rejects.toBeInstanceOf(ForbiddenError);
    await expect(updateAppointment(s, a.id, appointmentPayload({ version: a.version, description: "x" }))).rejects.toBeInstanceOf(ForbiddenError);
    await expect(cancelAppointment(s, a.id, {})).rejects.toBeInstanceOf(ForbiddenError);
  });

  it("assigning technicians and cancelling are separate permissions", async () => {
    await setUserAccess(asCurrent(admin), sara.id, { mode: "set", permissions: defaults("SALES").filter((p) => p !== "appointments.assign" && p !== "appointments.cancel") });
    const s = await fresh(sara);
    await expect(createAppointment(s, appointmentPayload({ technicianIds: [tech.id] }))).rejects.toMatchObject({ message: "You may not assign or change the technicians of a booking." });
    const own = await createAppointment(s, appointmentPayload({ date: "2031-02-02" }));
    expect(own.technicians).toEqual([]);
    // Editing other fields is allowed; changing the technicians is not; cancelling is not.
    const edited = await updateAppointment(s, own.id, appointmentPayload({ date: "2031-02-02", version: own.version, description: "Edited" }));
    expect(edited.description).toBe("Edited");
    await expect(updateAppointment(s, own.id, appointmentPayload({ date: "2031-02-02", version: edited.version, technicianIds: [tech.id] }))).rejects.toBeInstanceOf(ForbiddenError);
    await expect(cancelAppointment(s, own.id, {})).rejects.toBeInstanceOf(ForbiddenError);
    expect(edited.canCancel).toBe(false);
  });
});

describe("data scopes", () => {
  it("own records: a Sales employee sees and changes only the bookings they made", async () => {
    const mine = await book(sara);
    const theirs = await book(omar, [tech]);
    await setUserAccess(asCurrent(admin), sara.id, { mode: "set", permissions: defaults("SALES"), scopes: { appointments: "OWN" } });
    const s = await fresh(sara);
    expect((await listAppointments(s, filters)).rows.map((r) => r.id)).toEqual([mine.id]);
    await expect(getAppointment(s, theirs.id)).rejects.toBeInstanceOf(NotFoundError);
    await expect(updateAppointment(s, theirs.id, appointmentPayload({ version: theirs.version }))).rejects.toBeInstanceOf(NotFoundError);
    await expect(cancelAppointment(s, theirs.id, {})).rejects.toBeInstanceOf(NotFoundError);
    // Unchanged for everyone else: Omar still sees both.
    expect((await listAppointments(asCurrent(omar), filters)).total).toBe(2);
  });

  it("team records: a team leader sees the team's bookings and assignments, not other teams'", async () => {
    const north = await saveTeam(asCurrent(admin), null, { name: "North" });
    await setUserAccess(asCurrent(admin), tech.id, { mode: "set", permissions: defaults("TECHNICIAN"), teamId: north.id });
    await setUserAccess(asCurrent(admin), sara.id, { mode: "set", permissions: defaults("SALES"), scopes: { appointments: "TEAM" }, teamId: north.id });
    const own = await book(sara);
    const teamTech = await book(omar, [tech]);
    const otherTeam = await book(omar, [tech2]);
    const s = await fresh(sara);
    const seen = (await listAppointments(s, filters)).rows.map((r) => r.id).sort();
    expect(seen).toEqual([own.id, teamTech.id].sort());
    await expect(getAppointment(s, otherTeam.id)).rejects.toBeInstanceOf(NotFoundError);
    // Assigned: a technician sees only their own visits (the role default, now a configurable scope).
    expect((await listAppointments(asCurrent(tech2), filters)).rows.map((r) => r.id)).toEqual([otherTeam.id]);
  });

  it("customers: own customers only", async () => {
    const mine = await book(sara, [], { customer: { name: "Mine Customer", phone: "+20 100 000 0001" } });
    const theirs = await book(omar, [], { customer: { name: "Their Customer", phone: "+20 100 000 0002" } });
    await setUserAccess(asCurrent(admin), sara.id, { mode: "set", permissions: defaults("SALES"), scopes: { customers: "OWN" } });
    const s = await fresh(sara);
    expect((await listCustomers(s, {})).rows.map((r) => r.name)).toEqual(["Mine Customer"]);
    await expect(getCustomer(s, theirs.customer.id)).rejects.toBeInstanceOf(NotFoundError);
    expect((await getCustomer(s, mine.customer.id)).name).toBe("Mine Customer");
  });

  it("leave and expenses: a manager limited to the team decides only the team's", async () => {
    const north = await saveTeam(asCurrent(admin), null, { name: "North" });
    await setUserAccess(asCurrent(admin), tech.id, { mode: "set", permissions: defaults("TECHNICIAN"), teamId: north.id });
    await setUserAccess(asCurrent(admin), sara.id, { mode: "set", permissions: [...defaults("SALES"), "leaves.manage"], scopes: { leaves: "TEAM" }, teamId: north.id });
    const inTeam = await createLeave(asCurrent(tech), { startDate: "2031-05-01", endDate: "2031-05-02", type: "LEAVE" });
    const outside = await createLeave(asCurrent(tech2), { startDate: "2031-05-01", endDate: "2031-05-02", type: "LEAVE" });
    const s = await fresh(sara);
    expect((await decideLeave(s, inTeam.leave.id, { decision: "APPROVED" })).leave.status).toBe("APPROVED");
    await expect(decideLeave(s, outside.leave.id, { decision: "APPROVED" })).rejects.toBeInstanceOf(NotFoundError);
    await expect(createLeave(s, { userId: tech2.id, startDate: "2031-06-01", endDate: "2031-06-01", type: "LEAVE" })).rejects.toBeInstanceOf(ValidationError);

    // The accountant pays everyone's by default; limited to a team, only the team's are listed.
    await prisma.transportExpense.createMany({ data: [tech, tech2].map((u) => ({ userId: u.id, amount: 10, day: new Date(`${new Date().toISOString().slice(0, 7)}-01T00:00:00Z`) })) as never });
    expect((await listExpenses(asCurrent(accountant))).items).toHaveLength(2);
    await setUserAccess(asCurrent(admin), accountant.id, { mode: "set", permissions: defaults("ACCOUNTANT"), scopes: { expenses: "TEAM" }, teamId: north.id });
    expect((await listExpenses(await fresh(accountant))).items.map((e) => e.user.id)).toEqual([tech.id]);
  });
});

describe("audit log", () => {
  it("is append-only, also against TRUNCATE, and corrections are new entries", async () => {
    await book(sara);
    const entry = await prisma.auditLog.findFirstOrThrow();
    await expect(prisma.auditLog.update({ where: { id: entry.id }, data: { summary: "rewritten" } })).rejects.toThrow(/append-only/);
    await expect(prisma.auditLog.delete({ where: { id: entry.id } })).rejects.toThrow(/append-only/);
    await expect(prisma.$executeRawUnsafe(`TRUNCATE TABLE audit_logs`)).rejects.toThrow(/TRUNCATE is refused/);
    await expect(prisma.$executeRawUnsafe(`TRUNCATE TABLE users CASCADE`)).rejects.toThrow(/TRUNCATE is refused/);

    await expect(recordCorrection(asCurrent(sara), entry.id, { reason: "x", note: "y" })).rejects.toBeInstanceOf(ForbiddenError);
    await expect(recordCorrection(asCurrent(admin), entry.id, { reason: "", note: "y" })).rejects.toBeInstanceOf(ValidationError);
    await recordCorrection(asCurrent(admin), entry.id, { reason: "Booked for the wrong branch", note: "The booking belongs to the Zayed branch" });
    const correction = await prisma.auditLog.findFirstOrThrow({ where: { action: "AUDIT_CORRECTION" } });
    expect(correction).toMatchObject({ entityType: entry.entityType, entityId: entry.entityId, reason: "Booked for the wrong branch", actorId: admin.id });
    expect(correction.changes).toMatchObject({ correctsAuditId: entry.id });
    expect(await prisma.auditLog.findUniqueOrThrow({ where: { id: entry.id } })).toEqual(entry);
  });

  it("is the Admin's only, and filters by module, action, record and person", async () => {
    await expect(listAuditLog(asCurrent(sara), {})).rejects.toBeInstanceOf(ForbiddenError);
    await expect(listAuditLog(asCurrent(accountant), {})).rejects.toBeInstanceOf(ForbiddenError);
    const a = await book(sara);
    await setUserAccess(asCurrent(admin), omar.id, { mode: "template", template: "readOnly" });
    expect((await listAuditLog(asCurrent(admin), { module: "users" })).items.map((i) => i.action)).toEqual(["USER_ACCESS_CHANGED"]);
    expect((await listAuditLog(asCurrent(admin), { module: "appointments", action: "APPOINTMENT_CREATED" })).items.map((i) => i.entityId)).toEqual([a.id]);
    expect((await listAuditLog(asCurrent(admin), { entityId: omar.id })).total).toBe(1);
    expect((await listAuditLog(asCurrent(admin), { actorId: sara.id })).items.every((i) => i.actor?.id === sara.id)).toBe(true);
  });

  it("never stores secrets, and records attendance check-ins", async () => {
    await recordAudit(prisma, { entityType: "USER", entityId: sara.id, action: "TEST", summary: "audit.userUpdated", changes: { passwordHash: "x", nested: { token: "y", resetToken: "z", kept: 1 }, email: "a@b.c" }, actorId: admin.id });
    const row = await prisma.auditLog.findFirstOrThrow({ where: { action: "TEST" } });
    expect(row.changes).toEqual({ nested: { kept: 1 }, email: "a@b.c" });

    await recordCheckIn(asCurrent(tech), { kind: "COMPANY" });
    const checkIn = await prisma.auditLog.findFirstOrThrow({ where: { action: "CHECK_IN_COMPANY" } });
    expect(checkIn).toMatchObject({ module: "attendance", actorId: tech.id, entityType: "ATTENDANCE" });
  });
});
