import { beforeEach, describe, expect, it } from "vitest";
import type { User } from "@prisma/client";
import { createAppointment, getAppointmentHistory, updateAppointment, cancelAppointment } from "@/server/services/appointments";
import { activeTechnicians, createPasswordLink, createUser, setPasswordWithToken, updateUser } from "@/server/services/users";
import { buildReport, reportCsv } from "@/server/services/reports";
import { technicianAvailability } from "@/server/services/scheduling";
import { updateStatus } from "@/server/services/statuses";
import { ValidationError } from "@/server/errors";
import { verifyPassword } from "@/server/auth/password";
import { appointmentPayload, asCurrent, makeUser, prisma, resetDb, seedStatuses } from "../helpers";

let statuses: Awaited<ReturnType<typeof seedStatuses>>;
let admin: User;
let sales: User;

beforeEach(async () => {
  await resetDb();
  statuses = await seedStatuses();
  admin = await makeUser("ADMIN");
  sales = await makeUser("SALES");
});

describe("user management", () => {
  it("new active technicians appear in the assignment list automatically; deactivated ones disappear", async () => {
    const { user, invite } = await createUser(asCurrent(admin), { name: "New Tech", email: "NEW.TECH@test.local ", role: "TECHNICIAN" });
    expect(user.email).toBe("new.tech@test.local");
    expect(invite?.url).toMatch(/\/set-password\?token=/);
    expect((await activeTechnicians()).map((t) => t.id)).toContain(user.id);
    const availability = await technicianAvailability(prisma, { startsAt: new Date("2030-01-01T08:00:00Z"), endsAt: new Date("2030-01-01T09:00:00Z") });
    expect(availability.map((t) => t.id)).toContain(user.id);

    await updateUser(asCurrent(admin), user.id, { isActive: false });
    expect((await activeTechnicians()).map((t) => t.id)).not.toContain(user.id);
  });

  it("assigns a persistent colour to new Sales users and lets the Admin change it", async () => {
    const { user } = await createUser(asCurrent(admin), { name: "New Sales", email: "s@test.local", role: "SALES", password: "Password123" });
    expect(user.color).toMatch(/^#[0-9A-F]{6}$/);
    const updated = await updateUser(asCurrent(admin), user.id, { color: "#123abc" });
    expect(updated.color).toBe("#123ABC");
    await expect(updateUser(asCurrent(admin), user.id, { color: "red" })).rejects.toBeInstanceOf(ValidationError);
  });

  it("invitation links set the password once and expire after use", async () => {
    const { user, invite } = await createUser(asCurrent(admin), { name: "Invitee", email: "inv@test.local", role: "VIEWER" });
    const token = new URL(invite!.url).searchParams.get("token")!;
    await setPasswordWithToken(token, "BrandNewPass1");
    const row = await prisma.user.findUniqueOrThrow({ where: { id: user.id } });
    expect(await verifyPassword("BrandNewPass1", row.passwordHash)).toBe(true);
    expect(row.passwordHash).not.toContain("BrandNewPass1");
    await expect(setPasswordWithToken(token, "AnotherPass1")).rejects.toBeInstanceOf(ValidationError);
    // A reset link replaces any previous link.
    const reset = await createPasswordLink(asCurrent(admin), user.id);
    expect(reset.url).toContain("token=");
  });

  it("rejects duplicate emails and protects the last active Admin", async () => {
    await expect(createUser(asCurrent(admin), { name: "Dup", email: sales.email, role: "SALES" })).rejects.toBeInstanceOf(ValidationError);
    await expect(updateUser(asCurrent(admin), admin.id, { isActive: false })).rejects.toThrow();
    const other = await makeUser("ADMIN");
    await expect(updateUser(asCurrent(other), admin.id, { role: "SALES" })).resolves.toMatchObject({ role: "SALES" });
    await expect(updateUser(asCurrent(admin), other.id, { role: "SALES" })).rejects.toThrow();
  });

  it("revokes sessions when access changes", async () => {
    const tech = await makeUser("TECHNICIAN");
    await prisma.session.create({ data: { id: "abc", userId: tech.id, expiresAt: new Date(Date.now() + 3600_000) } });
    await updateUser(asCurrent(admin), tech.id, { isActive: false });
    expect(await prisma.session.count({ where: { userId: tech.id } })).toBe(0);
  });
});

describe("audit history", () => {
  it("records creation, edits, reschedules, technician and status changes with old and new values", async () => {
    const t1 = await makeUser("TECHNICIAN", { name: "T1" });
    const t2 = await makeUser("TECHNICIAN", { name: "T2" });
    const a = await createAppointment(asCurrent(sales), appointmentPayload({ technicianIds: [t1.id] }));
    await updateAppointment(
      asCurrent(admin),
      a.id,
      appointmentPayload({
        technicianIds: [t2.id],
        startTime: "16:00",
        location: { ...appointmentPayload().location, floor: "7" },
      }),
    );
    await cancelAppointment(asCurrent(sales), a.id, { reason: "Customer request" });
    const history = await getAppointmentHistory(asCurrent(admin), a.id);
    const actions = history.map((h) => h.action);
    expect(actions).toEqual(
      expect.arrayContaining(["APPOINTMENT_CREATED", "APPOINTMENT_UPDATED", "APPOINTMENT_RESCHEDULED", "TECHNICIANS_CHANGED", "APPOINTMENT_CANCELLED"]),
    );
    const upd = history.find((h) => h.action === "APPOINTMENT_UPDATED")!;
    expect(upd.changes).toMatchObject({ "location.floor": { from: "3", to: "7" } });
    expect(upd.actor?.id).toBe(admin.id);
    const techs = history.find((h) => h.action === "TECHNICIANS_CHANGED")!;
    expect(techs.changes).toMatchObject({ technicians: { from: ["T1"], to: ["T2"] } });
    // Technicians are notified about changes to their jobs.
    expect(await prisma.notification.count({ where: { userId: t2.id } })).toBeGreaterThan(0);
    expect(await prisma.notification.count({ where: { userId: t1.id, type: "UNASSIGNED" } })).toBe(1);
  });

  it("audit rows cannot be modified or deleted", async () => {
    await createAppointment(asCurrent(sales), appointmentPayload());
    const row = await prisma.auditLog.findFirstOrThrow();
    await expect(prisma.auditLog.update({ where: { id: row.id }, data: { summary: "tampered" } })).rejects.toThrow(/append-only/);
    await expect(prisma.auditLog.delete({ where: { id: row.id } })).rejects.toThrow(/append-only/);
  });

  it("making a status schedule-blocking is refused if it would create double bookings", async () => {
    const t = await makeUser("TECHNICIAN");
    const a = await createAppointment(asCurrent(sales), appointmentPayload({ technicianIds: [t.id] }));
    await cancelAppointment(asCurrent(sales), a.id, {});
    await createAppointment(asCurrent(sales), appointmentPayload({ technicianIds: [t.id] }));
    await expect(
      updateStatus(asCurrent(admin), statuses.CANCELLED, { name: "Cancelled", kind: "CANCELLED", color: "#6B7280", blocksSchedule: true }),
    ).rejects.toBeInstanceOf(ValidationError);
  });
});

describe("reports", () => {
  it("aggregates by status, sales, category and technician workload", async () => {
    const t = await makeUser("TECHNICIAN", { name: "Worker" });
    const a = await createAppointment(asCurrent(sales), appointmentPayload({ technicianIds: [t.id] }));
    await createAppointment(asCurrent(sales), appointmentPayload({ productCategory: "CCTV", startTime: "14:00", technicianIds: [t.id] }));
    await cancelAppointment(asCurrent(sales), a.id, {});
    const r = await buildReport(asCurrent(admin), { from: "2030-03-01", to: "2030-03-31" });
    expect(r.total).toBe(2);
    expect(r.cancelled).toBe(1);
    expect(r.bySales[0]).toMatchObject({ id: sales.id, count: 2 });
    expect(r.byCategory.map((c) => c.category).sort()).toEqual(["CCTV", "SMART_LOCK"]);
    expect(r.byTechnician[0]).toMatchObject({ name: "Worker", jobs: 1, minutes: 120, cancelled: 1 });
    expect(r.daily).toEqual([{ day: "2030-03-10", count: 2 }]);
  });

  it("CSV export never includes internal notes and neutralises formulas", async () => {
    await createAppointment(asCurrent(sales), appointmentPayload({ customer: { name: "=HYPERLINK(1)", phone: "01001234567" } }));
    const csv = await reportCsv(asCurrent(admin), "appointments", { from: "2030-03-01", to: "2030-03-31" });
    expect(csv).not.toContain("Deposit paid");
    expect(csv).toContain("'=HYPERLINK(1)");
    expect(csv).toContain("14B");
  });
});
