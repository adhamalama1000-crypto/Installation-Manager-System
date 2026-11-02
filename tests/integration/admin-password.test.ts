/**
 * The targeted recovery of admin@example.com (scripts/reset-admin-password.ts): it changes that
 * account's password and nothing else, lifts its sign-in lockout, and never creates an account,
 * changes a role or touches other users.
 */
import { beforeEach, describe, expect, it } from "vitest";
import type { User } from "@prisma/client";
import { POST as login } from "@/app/api/auth/login/route";
import { hashPassword, verifyPassword } from "@/server/auth/password";
import { ADMIN_EMAIL, adminStatus, describeDatabase, passwordProblem, resetAdminPassword } from "../../scripts/admin-password";
import { makeUser, prisma, resetDb } from "../helpers";

const OLD = "OldPassword123";
const NEW = "New-admin-pass-2026";

let admin: User, sales: User, other: User;
beforeEach(async () => {
  await resetDb();
  admin = await makeUser("ADMIN", { email: ADMIN_EMAIL, name: "System Admin", passwordHash: await hashPassword(OLD) });
  sales = await makeUser("SALES", { passwordHash: await hashPassword("SalesPass123") });
  other = await makeUser("ADMIN", { email: "second.admin@test.local", passwordHash: await hashPassword("Second123456") });
});

async function failures(email: string, n: number, ip = "10.0.0.1") {
  for (let i = 0; i < n; i++) await prisma.loginAttempt.create({ data: { email, ipAddress: ip, success: false } });
}
async function session(userId: string, id: string) {
  await prisma.session.create({ data: { id, userId, expiresAt: new Date(Date.now() + 3600_000) } });
}
const hashes = async () => Object.fromEntries((await prisma.user.findMany({ select: { email: true, passwordHash: true } })).map((u) => [u.email, u.passwordHash]));

function loginReq(email: string, password: string) {
  return new Request("http://localhost:3001/api/auth/login", { method: "POST", headers: { host: "localhost:3001", "content-type": "application/json" }, body: JSON.stringify({ email, password }) });
}

describe("checking the admin account", () => {
  it("reports existence, role, activity and lockout without changing anything", async () => {
    await failures(ADMIN_EMAIL, 5);
    await failures("someone@test.local", 30, "10.9.9.9");
    const before = await hashes();
    const s = await adminStatus(prisma);
    expect(s).toMatchObject({ exists: true, role: "ADMIN", isActive: true, hasPassword: true, recentFailures: 5, emailLocked: true });
    expect(s.lockedAddresses).toEqual(["10.9.9.9"]);
    expect(await hashes()).toEqual(before);
    // The admin really is locked out at the sign-in until the reset.
    expect((await login(loginReq(ADMIN_EMAIL, OLD))).status).toBe(429);
  });
});

describe("resetting the admin password", () => {
  it("changes only admin@example.com, lifts its lockout, ends its sessions and records it", async () => {
    await failures(ADMIN_EMAIL, 6);
    await failures(sales.email, 2);
    await session(admin.id, "admin-session-1");
    await session(sales.id, "sales-session-1");
    const before = await hashes();
    const users = await prisma.user.count();

    const r = await resetAdminPassword(prisma, { password: NEW });
    expect(r).toEqual({ activated: false, isActive: true, clearedFailures: 6, endedSessions: 1 });

    const after = await hashes();
    expect(await verifyPassword(NEW, after[ADMIN_EMAIL])).toBe(true);
    expect(await verifyPassword(OLD, after[ADMIN_EMAIL])).toBe(false);
    // Every other account is exactly as it was.
    for (const email of Object.keys(before).filter((e) => e !== ADMIN_EMAIL)) expect(after[email]).toBe(before[email]);
    expect(await prisma.user.count()).toBe(users);
    expect((await prisma.user.findUniqueOrThrow({ where: { id: admin.id } })).role).toBe("ADMIN");
    expect(await prisma.loginAttempt.count({ where: { email: ADMIN_EMAIL } })).toBe(0);
    expect(await prisma.loginAttempt.count({ where: { email: sales.email } })).toBe(2);
    expect(await prisma.session.count({ where: { userId: admin.id } })).toBe(0);
    expect(await prisma.session.count({ where: { userId: sales.id } })).toBe(1);
    const audit = await prisma.auditLog.findFirstOrThrow({ where: { entityId: admin.id, action: "PASSWORD_RESET_CLI" } });
    expect(audit.summary).toBe("System Admin's password was reset from the server command line");
    expect(JSON.stringify(audit)).not.toContain(NEW);

    // And the admin can sign in again with the new password.
    expect((await login(loginReq(ADMIN_EMAIL, NEW))).status).toBe(200);
    expect((await login(loginReq(other.email, "Second123456"))).status).toBe(200);
  });

  it("refuses a weak password, a missing account and a non-Admin account, changing nothing", async () => {
    const before = await hashes();
    await expect(resetAdminPassword(prisma, { password: "short1" })).rejects.toThrow(/at least 10/);
    await expect(resetAdminPassword(prisma, { password: "lettersonlypassword" })).rejects.toThrow(/letters and numbers/);
    expect(await hashes()).toEqual(before);

    await prisma.user.update({ where: { id: admin.id }, data: { role: "SALES" } });
    await expect(resetAdminPassword(prisma, { password: NEW })).rejects.toThrow(/not an Admin/);
    await prisma.user.update({ where: { id: admin.id }, data: { email: "renamed@test.local", role: "ADMIN" } });
    const users = await prisma.user.count();
    await expect(resetAdminPassword(prisma, { password: NEW })).rejects.toThrow(/no account admin@example.com/);
    expect(await prisma.user.count()).toBe(users); // nothing created
    expect(await hashes()).toEqual(Object.fromEntries(Object.entries(before).map(([e, h]) => [e === ADMIN_EMAIL ? "renamed@test.local" : e, h])));
  });

  it("re-activates a deactivated admin only when asked to", async () => {
    await prisma.user.update({ where: { id: admin.id }, data: { isActive: false } });
    expect((await resetAdminPassword(prisma, { password: NEW })).isActive).toBe(false);
    expect((await login(loginReq(ADMIN_EMAIL, NEW))).status).toBe(401);
    expect(await resetAdminPassword(prisma, { password: NEW, activate: true })).toMatchObject({ activated: true, isActive: true });
    expect((await login(loginReq(ADMIN_EMAIL, NEW))).status).toBe(200);
  });

  it("checks passwords like the app and names the database without credentials", () => {
    expect(passwordProblem("abc12345678")).toBeNull();
    expect(passwordProblem("x".repeat(129) + "1")).toMatch(/at most 128/);
    expect(describeDatabase("postgresql://ims:secret@localhost:5433/installation_manager?schema=public")).toBe("localhost:5433/installation_manager");
    expect(describeDatabase(undefined)).toMatch(/not set/);
  });
});
