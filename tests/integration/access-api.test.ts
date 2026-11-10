/**
 * Permissions, data scopes and the audit log through the real route handlers (session cookie ->
 * permission and scope checks -> JSON errors), the way a hand-made API call would reach them:
 * unauthenticated and non-Admin calls, attempts to raise one's own access, changed ids, and the
 * audit entries (with request context, never a password) that sign-in, sign-out, permission
 * changes and exports leave behind.
 */
import { beforeEach, describe, expect, it } from "vitest";
import type { User } from "@prisma/client";
import { POST as login } from "@/app/api/auth/login/route";
import { POST as logout } from "@/app/api/auth/logout/route";
import { POST as createAppt } from "@/app/api/appointments/route";
import { GET as getAppt } from "@/app/api/appointments/[id]/route";
import { GET as exportAppts } from "@/app/api/appointments/export/route";
import { GET as getAccess, PUT as putAccess } from "@/app/api/users/[id]/access/route";
import { GET as exportAudit } from "@/app/api/audit/export/route";
import { POST as correct } from "@/app/api/audit/[id]/correction/route";
import { GET as listTeams, POST as createTeam } from "@/app/api/teams/route";
import { PATCH as patchTeam } from "@/app/api/teams/[id]/route";
import { hashPassword } from "@/server/auth/password";
import { appointmentPayload, makeUser, prisma, resetDb, seedStatuses } from "../helpers";

const BASE = "http://localhost:3000";
const PASSWORD = "Password123";
const noParams = { params: Promise.resolve({}) };
const idParams = (id: string) => ({ params: Promise.resolve({ id }) });
const UA = "access-api-test/1.0";

function req(p: string, init: { method?: string; body?: unknown; cookie?: string; headers?: Record<string, string> } = {}) {
  const headers: Record<string, string> = { host: "localhost:3000", "user-agent": UA, "x-forwarded-for": "203.0.113.7", ...(init.headers ?? {}) };
  if (init.cookie) headers.cookie = init.cookie;
  if (init.body !== undefined) headers["content-type"] = "application/json";
  return new Request(`${BASE}${p}`, { method: init.method ?? "GET", headers, body: init.body === undefined ? undefined : JSON.stringify(init.body) });
}

async function signIn(email: string, password = PASSWORD): Promise<string> {
  const res = await login(req("/api/auth/login", { method: "POST", body: { email, password } }));
  expect(res.status).toBe(200);
  return res.headers.get("set-cookie")!.split(";")[0]!;
}

let admin: User;
let sales: User;
let sales2: User;
let tech: User;
let cookies: Record<"admin" | "sales" | "sales2" | "tech" | "accountant" | "viewer", string>;

beforeEach(async () => {
  await resetDb();
  await seedStatuses();
  const passwordHash = await hashPassword(PASSWORD);
  admin = await makeUser("ADMIN", { email: "admin@test.local", passwordHash });
  sales = await makeUser("SALES", { email: "sales@test.local", passwordHash });
  sales2 = await makeUser("SALES", { email: "sales2@test.local", passwordHash });
  tech = await makeUser("TECHNICIAN", { email: "tech@test.local", passwordHash });
  await makeUser("ACCOUNTANT", { email: "acc@test.local", passwordHash });
  await makeUser("VIEWER", { email: "viewer@test.local", passwordHash, viewerPermissions: ["appointments.view"] });
  cookies = {
    admin: await signIn("admin@test.local"),
    sales: await signIn("sales@test.local"),
    sales2: await signIn("sales2@test.local"),
    tech: await signIn("tech@test.local"),
    accountant: await signIn("acc@test.local"),
    viewer: await signIn("viewer@test.local"),
  };
});

describe("permission routes", () => {
  it("answer 401 without a session", async () => {
    expect((await getAccess(req(`/api/users/${sales.id}/access`), idParams(sales.id))).status).toBe(401);
    expect((await putAccess(req(`/api/users/${sales.id}/access`, { method: "PUT", body: { mode: "reset" } }), idParams(sales.id))).status).toBe(401);
    expect((await listTeams(req("/api/teams"), noParams)).status).toBe(401);
    expect((await exportAudit(req("/api/audit/export"), noParams)).status).toBe(401);
    const entry = await prisma.auditLog.findFirstOrThrow();
    expect((await correct(req(`/api/audit/${entry.id}/correction`, { method: "POST", body: { reason: "x", note: "y" } }), idParams(entry.id))).status).toBe(401);
  });

  it("are the Admin's alone: everybody else gets 403, for others and for themselves", async () => {
    const body = { mode: "set", permissions: ["appointments.view", "users.manage", "audit.view", "settings.manage"], scopes: { appointments: "ALL" }, reason: "please" };
    for (const who of ["sales", "tech", "accountant", "viewer"] as const) {
      const self = { sales, tech }[who as "sales" | "tech"];
      for (const target of [sales2.id, ...(self ? [self.id] : [])]) {
        expect((await getAccess(req(`/api/users/${target}/access`, { cookie: cookies[who] }), idParams(target))).status).toBe(403);
        expect((await putAccess(req(`/api/users/${target}/access`, { method: "PUT", cookie: cookies[who], body }), idParams(target))).status).toBe(403);
        expect((await putAccess(req(`/api/users/${target}/access`, { method: "PUT", cookie: cookies[who], body: { mode: "template", template: "teamLeader" } }), idParams(target))).status).toBe(403);
      }
      expect((await createTeam(req("/api/teams", { method: "POST", cookie: cookies[who], body: { name: "Mine" } }), noParams)).status).toBe(403);
    }
    // Nothing was stored, and nothing about access was logged.
    const stored = await prisma.user.findMany({ select: { permissionGrants: true, permissionDenies: true, dataScopes: true } });
    expect(stored.every((u) => u.permissionGrants.length === 0 && u.permissionDenies.length === 0 && u.dataScopes === null)).toBe(true);
    expect(await prisma.auditLog.count({ where: { action: "USER_ACCESS_CHANGED" } })).toBe(0);
  });

  it("an Admin-only permission written straight into the database still opens nothing", async () => {
    await prisma.user.update({ where: { id: sales.id }, data: { permissionGrants: ["users.manage", "audit.view", "settings.manage"], dataScopes: { audit: "ALL" } } });
    expect((await getAccess(req(`/api/users/${sales2.id}/access`, { cookie: cookies.sales }), idParams(sales2.id))).status).toBe(403);
    expect((await exportAudit(req("/api/audit/export", { cookie: cookies.sales }), noParams)).status).toBe(403);
  });

  it("an Admin cannot change their own access or another Admin's, nor hand out Admin-only permissions", async () => {
    const own = await putAccess(req(`/api/users/${admin.id}/access`, { method: "PUT", cookie: cookies.admin, body: { mode: "reset" } }), idParams(admin.id));
    expect(own.status).toBe(403);
    const other = await makeUser("ADMIN");
    expect((await putAccess(req(`/api/users/${other.id}/access`, { method: "PUT", cookie: cookies.admin, body: { mode: "set", permissions: [] } }), idParams(other.id))).status).toBe(422);
    const res = await putAccess(
      req(`/api/users/${sales.id}/access`, { method: "PUT", cookie: cookies.admin, body: { mode: "set", permissions: ["appointments.view", "users.manage"] } }),
      idParams(sales.id),
    );
    expect(res.status).toBe(422);
    expect((await res.json()).error.message).toContain("users.manage");
    // Malformed bodies and unknown modes are refused before anything is read.
    expect((await putAccess(req(`/api/users/${sales.id}/access`, { method: "PUT", cookie: cookies.admin, body: { mode: "grantAll" } }), idParams(sales.id))).status).toBe(422);
    expect((await putAccess(req(`/api/users/${sales.id}/access`, { method: "PUT", cookie: cookies.admin, body: { mode: "set", permissions: "all" } }), idParams(sales.id))).status).toBe(422);
    expect((await getAccess(req(`/api/users/nope/access`, { cookie: cookies.admin }), idParams("nope"))).status).toBe(404);
  });

  it("a change takes effect on the person's next request, and is logged with its reason and request context", async () => {
    const before = await getAccess(req(`/api/users/${sales.id}/access`, { cookie: cookies.admin }), idParams(sales.id));
    expect(before.status).toBe(200);
    const { access } = await before.json();
    expect(access.effective).toContain("appointments.create");
    const wanted = (access.effective as string[]).filter((p) => p !== "appointments.create" && p !== "appointments.manage");
    const put = await putAccess(
      req(`/api/users/${sales.id}/access`, { method: "PUT", cookie: cookies.admin, body: { mode: "set", permissions: wanted, scopes: access.scopes, reason: "Trainee for two weeks" } }),
      idParams(sales.id),
    );
    expect(put.status).toBe(200);

    // Same session cookie, no new sign-in: the booking is refused now.
    const refused = await createAppt(req("/api/appointments", { method: "POST", cookie: cookies.sales, body: appointmentPayload() }), noParams);
    expect(refused.status).toBe(403);

    const entry = await prisma.auditLog.findFirstOrThrow({ where: { action: "USER_ACCESS_CHANGED" } });
    expect(entry).toMatchObject({ module: "users", entityType: "USER", entityId: sales.id, actorId: admin.id, reason: "Trainee for two weeks" });
    expect(entry.context).toMatchObject({ ip: "203.0.113.7", userAgent: UA, method: "PUT", path: `/api/users/${sales.id}/access` });
    expect((entry.changes as { permissionsRemoved: string[] }).permissionsRemoved).toEqual(expect.arrayContaining(["appointments.create", "appointments.manage"]));

    // Saving the same set again changes nothing and logs nothing.
    const again = await putAccess(
      req(`/api/users/${sales.id}/access`, { method: "PUT", cookie: cookies.admin, body: { mode: "set", permissions: wanted, scopes: access.scopes } }),
      idParams(sales.id),
    );
    expect(await again.json()).toEqual({ changed: false });
    expect(await prisma.auditLog.count({ where: { action: "USER_ACCESS_CHANGED" } })).toBe(1);
  });

  it("deactivating someone ends their access at once, even with a live session", async () => {
    await prisma.user.update({ where: { id: sales.id }, data: { isActive: false } });
    expect((await createAppt(req("/api/appointments", { method: "POST", cookie: cookies.sales, body: appointmentPayload() }), noParams)).status).toBe(401);
  });
});

describe("data scopes through the API", () => {
  it("a Sales employee limited to their own records cannot open a colleague's booking by changing the id", async () => {
    const res = await createAppt(req("/api/appointments", { method: "POST", cookie: cookies.sales2, body: appointmentPayload() }), noParams);
    expect(res.status).toBe(201);
    const { appointment } = await res.json();
    // Default Sales scope: everything.
    expect((await getAppt(req(`/api/appointments/${appointment.id}`, { cookie: cookies.sales }), idParams(appointment.id))).status).toBe(200);

    const set = await putAccess(
      req(`/api/users/${sales.id}/access`, { method: "PUT", cookie: cookies.admin, body: { mode: "template", template: "salesOwnRecords", reason: "Own records only" } }),
      idParams(sales.id),
    );
    expect(set.status).toBe(200);
    expect((await getAppt(req(`/api/appointments/${appointment.id}`, { cookie: cookies.sales }), idParams(appointment.id))).status).toBe(404);
    // Their own booking still opens.
    const mine = await (await createAppt(req("/api/appointments", { method: "POST", cookie: cookies.sales, body: appointmentPayload({ customer: { name: "Mine", phone: "+20 100 999 0000", secondaryPhone: "" } }) }), noParams)).json();
    expect((await getAppt(req(`/api/appointments/${mine.appointment.id}`, { cookie: cookies.sales }), idParams(mine.appointment.id))).status).toBe(200);
    // And the technician, assigned to nothing, sees neither.
    expect((await getAppt(req(`/api/appointments/${appointment.id}`, { cookie: cookies.tech }), idParams(appointment.id))).status).toBe(404);
  });

  it("team scope follows the team, and a deactivated team stops counting", async () => {
    const team = await (await createTeam(req("/api/teams", { method: "POST", cookie: cookies.admin, body: { name: "East" } }), noParams)).json();
    for (const person of [sales, sales2]) {
      const access = (await (await getAccess(req(`/api/users/${person.id}/access`, { cookie: cookies.admin }), idParams(person.id))).json()).access;
      const res = await putAccess(
        req(`/api/users/${person.id}/access`, { method: "PUT", cookie: cookies.admin, body: { mode: "set", permissions: access.effective, scopes: { ...access.scopes, appointments: "TEAM" }, teamId: team.id } }),
        idParams(person.id),
      );
      expect(res.status).toBe(200);
    }
    const outsider = await makeUser("SALES", { email: "sales3@test.local", passwordHash: await hashPassword(PASSWORD) });
    const created = await createAppt(req("/api/appointments", { method: "POST", cookie: await signIn(outsider.email), body: appointmentPayload() }), noParams);
    const theirs = (await created.json()).appointment.id as string;
    const teammates = (await (await createAppt(req("/api/appointments", { method: "POST", cookie: cookies.sales2, body: appointmentPayload({ customer: { name: "Team", phone: "+20 100 555 0000", secondaryPhone: "" } }) }), noParams)).json()).appointment.id as string;
    expect((await getAppt(req(`/api/appointments/${teammates}`, { cookie: cookies.sales }), idParams(teammates))).status).toBe(200);
    expect((await getAppt(req(`/api/appointments/${theirs}`, { cookie: cookies.sales }), idParams(theirs))).status).toBe(404);

    expect((await patchTeam(req(`/api/teams/${team.id}`, { method: "PATCH", cookie: cookies.admin, body: { name: "East", isActive: false } }), idParams(team.id))).status).toBe(200);
    expect((await getAppt(req(`/api/appointments/${teammates}`, { cookie: cookies.sales }), idParams(teammates))).status).toBe(404);
    // Their own bookings stay visible.
    expect((await getAppt(req(`/api/appointments/${teammates}`, { cookie: cookies.sales2 }), idParams(teammates))).status).toBe(200);
    // And an inactive team cannot be given to anyone.
    const access = (await (await getAccess(req(`/api/users/${outsider.id}/access`, { cookie: cookies.admin }), idParams(outsider.id))).json()).access;
    const refused = await putAccess(req(`/api/users/${outsider.id}/access`, { method: "PUT", cookie: cookies.admin, body: { mode: "set", permissions: access.effective, scopes: access.scopes, teamId: team.id } }), idParams(outsider.id));
    expect(refused.status).toBe(422);
  });

  it("an export needs its own permission, and every export is logged", async () => {
    const ok = await exportAppts(req("/api/appointments/export", { cookie: cookies.sales }), noParams);
    expect(ok.status).toBe(200);
    const logged = await prisma.auditLog.findFirstOrThrow({ where: { action: "EXPORTED", actorId: sales.id } });
    expect(logged).toMatchObject({ module: "appointments", entityId: "export:appointments" });
    expect(logged.context).toMatchObject({ method: "GET", path: "/api/appointments/export" });

    await prisma.user.update({ where: { id: sales.id }, data: { permissionDenies: ["appointments.export"] } });
    expect((await exportAppts(req("/api/appointments/export", { cookie: cookies.sales }), noParams)).status).toBe(403);
    expect(await prisma.auditLog.count({ where: { action: "EXPORTED", actorId: sales.id } })).toBe(1);
  });
});

describe("audit log routes", () => {
  it("export is the Admin's and is itself logged; corrections add an entry and leave the original as it was", async () => {
    for (const who of ["sales", "tech", "accountant", "viewer"] as const) {
      expect((await exportAudit(req("/api/audit/export?module=auth", { cookie: cookies[who] }), noParams)).status).toBe(403);
    }
    const csv = await exportAudit(req("/api/audit/export?module=auth&action=LOGIN_SUCCEEDED", { cookie: cookies.admin }), noParams);
    expect(csv.status).toBe(200);
    expect(csv.headers.get("content-type")).toContain("text/csv");
    const text = await csv.text();
    expect(text.split("\n").filter((l) => l.includes("LOGIN_SUCCEEDED"))).toHaveLength(6);
    expect(text).not.toContain(PASSWORD);
    expect(await prisma.auditLog.count({ where: { action: "EXPORTED", module: "audit" } })).toBe(1);

    const original = await prisma.auditLog.findFirstOrThrow({ where: { action: "LOGIN_SUCCEEDED", actorId: sales.id } });
    expect((await correct(req(`/api/audit/${original.id}/correction`, { method: "POST", cookie: cookies.sales, body: { reason: "r", note: "n" } }), idParams(original.id))).status).toBe(403);
    expect((await correct(req(`/api/audit/${original.id}/correction`, { method: "POST", cookie: cookies.admin, body: { reason: "", note: "n" } }), idParams(original.id))).status).toBe(422);
    expect((await correct(req(`/api/audit/nope/correction`, { method: "POST", cookie: cookies.admin, body: { reason: "r", note: "n" } }), idParams("nope"))).status).toBe(404);
    const res = await correct(
      req(`/api/audit/${original.id}/correction`, { method: "POST", cookie: cookies.admin, body: { reason: "Shared device", note: "Signed in by the store keeper" } }),
      idParams(original.id),
    );
    expect(res.status).toBe(201);
    const correction = await prisma.auditLog.findFirstOrThrow({ where: { action: "AUDIT_CORRECTION" } });
    expect(correction).toMatchObject({ entityType: "AUTH", entityId: original.entityId, reason: "Shared device", actorId: admin.id });
    expect(correction.changes).toMatchObject({ correctsAuditId: original.id, correctsAction: "LOGIN_SUCCEEDED" });
    expect(await prisma.auditLog.findUniqueOrThrow({ where: { id: original.id } })).toEqual(original);
  });

  it("teams are created and renamed by the Admin, and both are logged", async () => {
    const created = await createTeam(req("/api/teams", { method: "POST", cookie: cookies.admin, body: { name: "North", nameAr: "الشمال" } }), noParams);
    expect(created.status).toBe(201);
    const team = await created.json();
    expect((await patchTeam(req(`/api/teams/${team.id}`, { method: "PATCH", cookie: cookies.sales, body: { name: "Mine" } }), idParams(team.id))).status).toBe(403);
    expect((await patchTeam(req(`/api/teams/${team.id}`, { method: "PATCH", cookie: cookies.admin, body: { name: "North Cairo" } }), idParams(team.id))).status).toBe(200);
    // A partial change leaves the other fields alone.
    expect(await prisma.team.findUniqueOrThrow({ where: { id: team.id } })).toMatchObject({ name: "North Cairo", nameAr: "الشمال", isActive: true });
    expect((await patchTeam(req(`/api/teams/nope`, { method: "PATCH", cookie: cookies.admin, body: { name: "X" } }), idParams("nope"))).status).toBe(404);
    expect((await createTeam(req("/api/teams", { method: "POST", cookie: cookies.admin, body: { name: "  " } }), noParams)).status).toBe(422);
    expect((await prisma.auditLog.findMany({ where: { module: "users", action: { startsWith: "TEAM_" } }, orderBy: { createdAt: "asc" } })).map((a) => a.action)).toEqual(["TEAM_CREATED", "TEAM_UPDATED"]);
  });
});

describe("sign-in and sign-out entries", () => {
  it("record success, failure (with the cause, for the Admin only), lockout and sign-out, with request context and no password", async () => {
    const ok = await prisma.auditLog.findFirstOrThrow({ where: { action: "LOGIN_SUCCEEDED", actorId: sales.id } });
    expect(ok).toMatchObject({ module: "auth", entityType: "AUTH", entityId: sales.id });
    expect(ok.context).toMatchObject({ ip: "203.0.113.7", userAgent: UA, method: "POST", path: "/api/auth/login" });

    const wrong = await login(req("/api/auth/login", { method: "POST", body: { email: "sales@test.local", password: "Wrong-Password-9" } }));
    expect(wrong.status).toBe(401);
    const unknown = await login(req("/api/auth/login", { method: "POST", body: { email: "ghost@test.local", password: "Wrong-Password-9" } }));
    expect(unknown.status).toBe(401);
    // Both answers look the same to the caller.
    expect((await wrong.json()).error.message).toBe((await unknown.json()).error.message);
    const failures = await prisma.auditLog.findMany({ where: { action: "LOGIN_FAILED" }, orderBy: { createdAt: "asc" } });
    expect(failures.map((f) => (f.changes as { cause: string }).cause)).toEqual(["wrong password", "unknown account"]);
    expect(failures[0]).toMatchObject({ actorId: sales.id, entityId: sales.id });
    expect(failures[1]).toMatchObject({ actorId: null, entityId: "ghost@test.local" });

    await prisma.user.update({ where: { id: tech.id }, data: { isActive: false } });
    expect((await login(req("/api/auth/login", { method: "POST", body: { email: "tech@test.local", password: PASSWORD } }))).status).toBe(401);
    expect(await prisma.auditLog.count({ where: { action: "LOGIN_FAILED", actorId: tech.id, changes: { path: ["cause"], equals: "inactive account" } } })).toBe(1);

    // Repeated failures lock the address out; the lockout is logged too.
    for (let i = 0; i < 5; i++) await login(req("/api/auth/login", { method: "POST", body: { email: "sales2@test.local", password: "Wrong-Password-9" } }));
    const blocked = await login(req("/api/auth/login", { method: "POST", body: { email: "sales2@test.local", password: PASSWORD } }));
    expect(blocked.status).toBe(429);
    expect(await prisma.auditLog.count({ where: { action: "LOGIN_BLOCKED", entityId: "sales2@test.local" } })).toBeGreaterThanOrEqual(1);

    const out = await logout(req("/api/auth/logout", { method: "POST", cookie: cookies.sales }));
    expect(out.status).toBe(200);
    expect(await prisma.auditLog.count({ where: { action: "LOGOUT", actorId: sales.id } })).toBe(1);
    // A second sign-out with the dead cookie logs nothing more.
    await logout(req("/api/auth/logout", { method: "POST", cookie: cookies.sales }));
    expect(await prisma.auditLog.count({ where: { action: "LOGOUT" } })).toBe(1);

    // No password, hash or session token anywhere in the log.
    const all = JSON.stringify(await prisma.auditLog.findMany());
    expect(all).not.toContain(PASSWORD);
    expect(all).not.toContain("Wrong-Password-9");
    expect(all).not.toMatch(/passwordHash|\$argon2|\$2[aby]\$/);
    expect(all).not.toContain(cookies.admin.split("=")[1]!);
  });
});
