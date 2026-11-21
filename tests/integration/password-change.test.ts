/**
 * Changing one's own password (audit M3): limited per user like the sign-in, every wrong current
 * password audited without secrets, simultaneous changes cannot both win, and a change signs out
 * the other sessions.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { User } from "@prisma/client";
import { POST as changePassword } from "@/app/api/me/password/route";
import { POST as login } from "@/app/api/auth/login/route";
import { hashPassword, verifyPassword } from "@/server/auth/password";
import { resetHashPoolForTests } from "@/server/auth/hash-pool";
import { passwordChangeKey } from "@/lib/login-limits";
import { makeUser, prisma, resetDb } from "../helpers";

const OLD = "Old-Password-1";
const NEW = "New-Password-22";
const WRONG = "Not-My-Password-3";
const noParams = { params: Promise.resolve({}) };
let user: User;
let hash: string;

function req(path: string, body: unknown, cookie?: string) {
  return new Request(`http://localhost:3000${path}`, {
    method: "POST",
    headers: { host: "localhost:3000", "content-type": "application/json", ...(cookie ? { cookie } : {}) },
    body: JSON.stringify(body),
  });
}
async function signIn(password = OLD) {
  const res = await login(req("/api/auth/login", { email: user.email, password }));
  expect(res.status).toBe(200);
  return res.headers.getSetCookie().find((c) => c.startsWith("ims_session="))!.split(";")[0]!;
}
const change = (cookie: string, currentPassword: string, newPassword = NEW) => changePassword(req("/api/me/password", { currentPassword, newPassword }, cookie), noParams);

async function awayFromWindowEdge() {
  const left = 15 * 60_000 - (Date.now() % (15 * 60_000));
  if (left < 15_000) await new Promise((r) => setTimeout(r, left + 200));
}

beforeEach(async () => {
  await resetHashPoolForTests();
  await resetDb();
  hash ??= await hashPassword(OLD);
  user = await makeUser("SALES", { email: "me@test.local", passwordHash: hash });
  await awayFromWindowEdge();
});
afterEach(async () => {
  vi.restoreAllMocks();
  await resetHashPoolForTests();
});

describe("changing one's own password", () => {
  it("works with the right current password and signs out the other sessions only", async () => {
    const mine = await signIn();
    const other = await signIn();
    const res = await change(mine, OLD);
    expect(res.status).toBe(200);
    const stored = await prisma.user.findUniqueOrThrow({ where: { id: user.id } });
    expect(await verifyPassword(NEW, stored.passwordHash)).toBe(true);
    expect(stored.passwordHash).toMatch(/^\$2b\$12\$/); // same algorithm and cost
    expect(await prisma.session.count({ where: { userId: user.id } })).toBe(1);
    // The other session is gone; this one still works.
    expect((await change(other, NEW, "Another-Password-4")).status).toBe(401);
    expect((await change(mine, NEW, "Another-Password-4")).status).toBe(200);
    expect(await prisma.auditLog.count({ where: { action: "USER_PASSWORD_CHANGED", entityId: user.id } })).toBe(2);
  });

  it("refuses a wrong current password with the usual answer and audits it, without any secret", async () => {
    const cookie = await signIn();
    const res = await change(cookie, WRONG);
    expect(res.status).toBe(422);
    expect((await res.json()).error.fieldErrors.currentPassword).toBeTruthy();
    const audits = await prisma.auditLog.findMany({ where: { action: "USER_PASSWORD_CHANGE_FAILED" } });
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({ entityId: user.id, actorId: user.id });
    const all = JSON.stringify(await prisma.auditLog.findMany());
    for (const secret of [OLD, NEW, WRONG, hash]) expect(all).not.toContain(secret);
    expect(all).not.toMatch(/\$2[aby]\$/);
    // Nothing changed.
    expect((await prisma.user.findUniqueOrThrow({ where: { id: user.id } })).passwordHash).toBe(hash);
  });

  it("allows 5 attempts per window, then answers 429 with Retry-After (audited once); a success is not blocked before that", async () => {
    const cookie = await signIn();
    for (let i = 0; i < 5; i++) expect((await change(cookie, WRONG)).status).toBe(422);
    const blocked = await change(cookie, OLD); // even the right password, until the window ends
    expect(blocked.status).toBe(429);
    expect(Number(blocked.headers.get("retry-after"))).toBeGreaterThan(0);
    expect((await change(cookie, WRONG)).status).toBe(429);
    expect(await prisma.auditLog.count({ where: { action: "USER_PASSWORD_CHANGE_FAILED" } })).toBe(5);
    expect(await prisma.auditLog.count({ where: { action: "USER_PASSWORD_CHANGE_BLOCKED" } })).toBe(1);
    expect((await prisma.user.findUniqueOrThrow({ where: { id: user.id } })).passwordHash).toBe(hash);
  });

  it("clears the counter after a success, and counts per user", async () => {
    const cookie = await signIn();
    for (let i = 0; i < 4; i++) await change(cookie, WRONG);
    expect((await change(cookie, OLD)).status).toBe(200);
    expect(await prisma.authRateLimit.count({ where: { key: passwordChangeKey(user.id) } })).toBe(0);
  });

  it("checks at most 5 of 30 simultaneous attempts, and two simultaneous right ones cannot both win", async () => {
    const cookie = await signIn();
    const rs = await Promise.all(Array.from({ length: 30 }, () => change(cookie, WRONG)));
    const s = rs.reduce<Record<number, number>>((m, r) => ((m[r.status] = (m[r.status] ?? 0) + 1), m), {});
    // At most 5 checked; the rest refused by the limit (429) or the per-user pool cap (503, not counted).
    expect(s[422] ?? 0).toBeLessThanOrEqual(5);
    expect((s[422] ?? 0) + (s[429] ?? 0) + (s[503] ?? 0)).toBe(30);

    await prisma.authRateLimit.deleteMany();
    const [a, b] = await Promise.all([change(cookie, OLD, "Winner-Password-5"), change(cookie, OLD, "Other-Password-6")]);
    const codes = [a.status, b.status].sort();
    // One wins; the other is refused (changed meanwhile, or the per-user pool cap) and never overwrites it.
    expect(codes[0]).toBe(200);
    expect([409, 503]).toContain(codes[1]);
    const stored = (await prisma.user.findUniqueOrThrow({ where: { id: user.id } })).passwordHash;
    const winner = a.status === 200 ? "Winner-Password-5" : "Other-Password-6";
    expect(await verifyPassword(winner, stored)).toBe(true);
    expect(await prisma.auditLog.count({ where: { action: "USER_PASSWORD_CHANGED" } })).toBe(1);
  });

  it("fails closed (503) when the limit counters cannot be reached", async () => {
    const cookie = await signIn();
    const errors = vi.spyOn(console, "error").mockImplementation(() => undefined);
    // Only the limit counters are unreachable (the session lookup still works).
    const real = prisma.$queryRaw.bind(prisma);
    vi.spyOn(prisma, "$queryRaw").mockImplementation(((query: TemplateStringsArray | { strings?: readonly string[] }, ...values: unknown[]) => {
      const text = Array.isArray(query) ? query.join("?") : ((query as { strings?: readonly string[] }).strings ?? []).join("?");
      if (text.includes("auth_rate_limits")) return Promise.reject(new Error("connection refused"));
      return (real as (...a: unknown[]) => unknown)(query, ...values);
    }) as typeof prisma.$queryRaw);
    const res = await change(cookie, OLD);
    expect(res.status).toBe(503);
    vi.restoreAllMocks();
    expect((await prisma.user.findUniqueOrThrow({ where: { id: user.id } })).passwordHash).toBe(hash);
    expect(JSON.stringify(errors.mock.calls)).not.toContain(OLD);
  });
});
