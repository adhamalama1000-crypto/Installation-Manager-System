/**
 * Custom roles and the Installation manager role, through the real session loader (so the
 * effective permissions are exactly what a request sees) and the real API routes for the
 * authorization checks.
 */
import { beforeEach, describe, expect, it } from "vitest";
import type { User } from "@prisma/client";
import { GET as listRolesRoute, POST as createRoleRoute } from "@/app/api/access-roles/route";
import { PUT as updateRoleRoute } from "@/app/api/access-roles/[id]/route";
import { createSession, userFromToken } from "@/server/auth/session";
import { createAccessRole, getAccessRole, listAccessRoles, updateAccessRole } from "@/server/services/access-roles";
import { getUserAccess, setUserAccess } from "@/server/services/access-control";
import { updateUser } from "@/server/services/users";
import { createAppointment } from "@/server/services/appointments";
import { ForbiddenError, StaleRecordError, ValidationError } from "@/server/errors";
import { appointmentPayload, asCurrent, makeUser, prisma, resetDb, seedStatuses } from "../helpers";

let admin: User;
let sales: User;

async function sessionOf(u: User) {
  const { token } = await createSession(u.id, { userAgent: "test" });
  const cu = await userFromToken(token);
  expect(cu).not.toBeNull();
  return cu!;
}

const cookieOf = async (u: User) => `ims_session=${(await createSession(u.id, { userAgent: "test" })).token}`;
const req = (p: string, method: string, cookie: string, body?: unknown) =>
  new Request(`http://localhost:3000${p}`, { method, headers: { host: "localhost:3000", cookie, ...(body ? { "content-type": "application/json" } : {}) }, body: body ? JSON.stringify(body) : undefined });

beforeEach(async () => {
  await resetDb();
  await seedStatuses();
  admin = await makeUser("ADMIN");
  sales = await makeUser("SALES");
});

describe("custom roles", () => {
  it("an Admin creates a role from a base role; it starts from the base defaults when no permissions are given", async () => {
    const { id } = await createAccessRole(asCurrent(admin), { name: "Sales (copy)", baseRole: "SALES" });
    const role = await getAccessRole(asCurrent(admin), id);
    expect(role.permissions).toEqual(role.baseDefaults);
    const audit = await prisma.auditLog.findFirst({ where: { action: "ACCESS_ROLE_CREATED", entityId: id } });
    expect(audit?.module).toBe("users");
  });

  it("gives the role's permissions and scopes to its people, with individual changes still on top", async () => {
    const { id } = await createAccessRole(asCurrent(admin), {
      name: "Junior sales",
      baseRole: "SALES",
      permissions: ["appointments.view", "appointments.create", "customers.view", "reports.view"],
      scopes: { appointments: "OWN" },
    });
    await setUserAccess(asCurrent(admin), sales.id, { mode: "role", accessRoleId: id, reason: "new hire" });
    let me = await sessionOf(sales);
    expect(me.permissions).toContain("reports.view");
    expect(me.permissions).toContain("appointments.create");
    expect(me.permissions).not.toContain("appointments.manage");
    expect(me.permissions).not.toContain("appointments.cancel");
    expect(me.scopes.appointments).toBe("OWN");

    // An individual grant is stored relative to the custom role, not the base role.
    await setUserAccess(asCurrent(admin), sales.id, { mode: "set", permissions: [...me.permissions, "appointments.export"], scopes: { appointments: "OWN" }, reason: null });
    const stored = await prisma.user.findUniqueOrThrow({ where: { id: sales.id } });
    expect(stored.permissionGrants).toEqual(["appointments.export"]);
    expect(stored.dataScopes).toBeNull(); // OWN is what the role gives: nothing stored for the person
    me = await sessionOf(sales);
    expect(me.permissions).toContain("appointments.export");

    const access = await getUserAccess(asCurrent(admin), sales.id);
    expect(access.accessRole?.id).toBe(id);
    expect(access.roleDefaults).toEqual(["appointments.view", "appointments.create", "customers.view", "reports.view"]);
  });

  it("editing a role changes its people's access on their next request; the change is audited", async () => {
    const { id } = await createAccessRole(asCurrent(admin), { name: "R", baseRole: "SALES", permissions: ["appointments.view", "reports.view"] });
    await setUserAccess(asCurrent(admin), sales.id, { mode: "role", accessRoleId: id, reason: null });
    const { token } = await createSession(sales.id, { userAgent: "t" });
    expect((await userFromToken(token))!.permissions).toContain("reports.view");
    const role = await getAccessRole(asCurrent(admin), id);
    await updateAccessRole(asCurrent(admin), id, { name: "R", permissions: ["appointments.view"], version: role.version, reason: "tighten" });
    expect((await userFromToken(token))!.permissions).not.toContain("reports.view");
    const audit = await prisma.auditLog.findFirst({ where: { action: "ACCESS_ROLE_UPDATED", entityId: id } });
    expect((audit?.changes as { permissionsRemoved: string[] }).permissionsRemoved).toEqual(["reports.view"]);
    expect(audit?.reason).toBe("tighten");
    // A stale version is refused instead of overwriting someone else's edit.
    await expect(updateAccessRole(asCurrent(admin), id, { name: "R2", version: role.version })).rejects.toBeInstanceOf(StaleRecordError);
  });

  it("never holds Admin-only permissions; a Viewer-based role stays read-only; the base role is fixed", async () => {
    await expect(createAccessRole(asCurrent(admin), { name: "X", baseRole: "SALES", permissions: ["users.manage"] })).rejects.toBeInstanceOf(ValidationError);
    await expect(createAccessRole(asCurrent(admin), { name: "V", baseRole: "VIEWER", permissions: ["appointments.create"] })).rejects.toBeInstanceOf(ValidationError);
    await expect(createAccessRole(asCurrent(admin), { name: "A", baseRole: "ADMIN" })).rejects.toBeInstanceOf(ValidationError);
    await expect(createAccessRole(asCurrent(admin), { name: "  ", baseRole: "SALES" })).rejects.toBeInstanceOf(ValidationError);
    const { id } = await createAccessRole(asCurrent(admin), { name: "V", baseRole: "VIEWER", permissions: ["appointments.view", "reports.view", "reports.export"] });
    await expect(updateAccessRole(asCurrent(admin), id, { name: "V", baseRole: "SALES" })).rejects.toBeInstanceOf(ValidationError);
  });

  it("can only be given to people of its base role, and only while active", async () => {
    const tech = await makeUser("TECHNICIAN");
    const { id } = await createAccessRole(asCurrent(admin), { name: "S", baseRole: "SALES" });
    await expect(setUserAccess(asCurrent(admin), tech.id, { mode: "role", accessRoleId: id, reason: null })).rejects.toBeInstanceOf(ValidationError);
    const off = await createAccessRole(asCurrent(admin), { name: "Off", baseRole: "SALES" });
    await updateAccessRole(asCurrent(admin), off.id, { name: "Off", isActive: false });
    await expect(setUserAccess(asCurrent(admin), sales.id, { mode: "role", accessRoleId: off.id, reason: null })).rejects.toBeInstanceOf(ValidationError);
  });

  it("cannot be deactivated while people have it, and is never deleted", async () => {
    const { id } = await createAccessRole(asCurrent(admin), { name: "S", baseRole: "SALES" });
    await setUserAccess(asCurrent(admin), sales.id, { mode: "role", accessRoleId: id, reason: null });
    await expect(updateAccessRole(asCurrent(admin), id, { name: "S", isActive: false })).rejects.toBeInstanceOf(ValidationError);
    await setUserAccess(asCurrent(admin), sales.id, { mode: "role", accessRoleId: null, reason: null });
    await updateAccessRole(asCurrent(admin), id, { name: "S", isActive: false });
    await expect(prisma.accessRole.delete({ where: { id } })).rejects.toThrow(/cannot be deleted/);
    expect((await listAccessRoles(asCurrent(admin))).custom.find((r) => r.id === id)?.isActive).toBe(false);
  });

  it("is cleared when the person's base role changes", async () => {
    const { id } = await createAccessRole(asCurrent(admin), { name: "S", baseRole: "SALES" });
    await setUserAccess(asCurrent(admin), sales.id, { mode: "role", accessRoleId: id, reason: null });
    await updateUser(asCurrent(admin), sales.id, { name: sales.name, email: sales.email, role: "ACCOUNTANT" });
    const u = await prisma.user.findUniqueOrThrow({ where: { id: sales.id } });
    expect(u.accessRoleId).toBeNull();
  });

  it("only an Admin manages roles: the API refuses others, and nobody changes their own role", async () => {
    const wm = await makeUser("WAREHOUSE_MANAGER");
    const im = await makeUser("INSTALLATION_MANAGER");
    for (const u of [wm, im, sales]) {
      const cookie = await cookieOf(u);
      expect((await listRolesRoute(req("/api/access-roles", "GET", cookie), { params: Promise.resolve({}) })).status).toBe(403);
      expect((await createRoleRoute(req("/api/access-roles", "POST", cookie, { name: "Hack", baseRole: "SALES", permissions: ["finance.view"] }), { params: Promise.resolve({}) })).status).toBe(403);
    }
    const { id } = await createAccessRole(asCurrent(admin), { name: "S", baseRole: "SALES" });
    const res = await updateRoleRoute(req(`/api/access-roles/${id}`, "PUT", await cookieOf(sales), { name: "S", permissions: ["finance.view"] }), { params: Promise.resolve({ id }) });
    expect(res.status).toBe(403);
    await expect(createAccessRole(asCurrent(sales), { name: "S", baseRole: "SALES" })).rejects.toBeInstanceOf(ForbiddenError);
    const otherAdmin = await makeUser("ADMIN");
    await expect(setUserAccess(asCurrent(otherAdmin), otherAdmin.id, { mode: "role", accessRoleId: null, reason: null })).rejects.toBeInstanceOf(ForbiddenError);
    const ok = await listRolesRoute(req("/api/access-roles", "GET", await cookieOf(admin)), { params: Promise.resolve({}) });
    expect(ok.status).toBe(200);
  });
});

describe("Installation manager role", () => {
  it("books and assigns visits, but has no money, stock movements, users or settings", async () => {
    const im = await makeUser("INSTALLATION_MANAGER");
    const tech = await makeUser("TECHNICIAN");
    const me = await sessionOf(im);
    for (const p of ["appointments.create", "appointments.manage", "appointments.assign", "appointments.cancel", "leaves.manage", "complaints.manage", "evidence.review", "board.view"]) {
      expect(me.permissions, p).toContain(p);
    }
    for (const p of ["finance.view", "cash.receive", "inventory.issue", "inventory.approve", "users.manage", "settings.manage", "audit.view", "sales.manage"]) {
      expect(me.permissions, p).not.toContain(p);
    }
    expect(me.scopes.appointments).toBe("ALL");
    const appt = await createAppointment(me, appointmentPayload({ technicianIds: [tech.id], salesUserId: sales.id }));
    expect(appt.id).toBeTruthy();
  });
});
