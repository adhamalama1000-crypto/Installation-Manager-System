/**
 * Exercises the real Next.js route handlers (authentication cookie -> session -> permission
 * checks -> JSON errors) without a browser.
 */
import { beforeEach, describe, expect, it } from "vitest";
import type { User } from "@prisma/client";
import { POST as login } from "@/app/api/auth/login/route";
import { POST as logout } from "@/app/api/auth/logout/route";
import { GET as listAppts, POST as createAppt } from "@/app/api/appointments/route";
import { GET as getAppt, PATCH as patchAppt } from "@/app/api/appointments/[id]/route";
import { POST as cancelAppt } from "@/app/api/appointments/[id]/cancel/route";
import { POST as createUserRoute } from "@/app/api/users/route";
import { POST as availability } from "@/app/api/appointments/availability/route";
import { GET as exportCsv } from "@/app/api/reports/export/route";
import { hashPassword } from "@/server/auth/password";
import { appointmentPayload, makeUser, prisma, resetDb, seedStatuses } from "../helpers";

const BASE = "http://localhost:3000";
const PASSWORD = "Password123";
const noParams = { params: Promise.resolve({}) };
const idParams = (id: string) => ({ params: Promise.resolve({ id }) });

function req(path: string, init: { method?: string; body?: unknown; cookie?: string; headers?: Record<string, string> } = {}) {
  const headers: Record<string, string> = { host: "localhost:3000", ...(init.headers ?? {}) };
  if (init.cookie) headers.cookie = init.cookie;
  if (init.body !== undefined) headers["content-type"] = "application/json";
  return new Request(`${BASE}${path}`, {
    method: init.method ?? "GET",
    headers,
    body: init.body === undefined ? undefined : typeof init.body === "string" ? init.body : JSON.stringify(init.body),
  });
}

async function signIn(email: string, password = PASSWORD): Promise<string> {
  const res = await login(req("/api/auth/login", { method: "POST", body: { email, password } }));
  expect(res.status).toBe(200);
  const setCookie = res.headers.get("set-cookie")!;
  expect(setCookie).toMatch(/ims_session=/);
  expect(setCookie.toLowerCase()).toContain("httponly");
  return setCookie.split(";")[0]!;
}

let sales: User;
let tech: User;
let otherTech: User;
let viewer: User;

beforeEach(async () => {
  await resetDb();
  await seedStatuses();
  const passwordHash = await hashPassword(PASSWORD);
  await makeUser("ADMIN", { email: "admin@test.local", passwordHash });
  sales = await makeUser("SALES", { email: "sales@test.local", passwordHash });
  tech = await makeUser("TECHNICIAN", { email: "tech@test.local", passwordHash });
  otherTech = await makeUser("TECHNICIAN", { email: "tech2@test.local", passwordHash });
  viewer = await makeUser("VIEWER", { email: "viewer@test.local", passwordHash, viewerPermissions: ["appointments.view"] });
});

describe("authentication", () => {
  it("rejects unauthenticated API calls with a clean 401", async () => {
    const res = await listAppts(req("/api/appointments"), noParams);
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.error.code).toBe("UNAUTHORIZED");
    expect(JSON.stringify(body)).not.toMatch(/at .*\.ts/); // no stack traces
  });

  it("logs in, uses the session cookie, and logs out", async () => {
    const cookie = await signIn("SALES@test.local");
    expect((await listAppts(req("/api/appointments", { cookie }), noParams)).status).toBe(200);
    expect((await logout(req("/api/auth/logout", { method: "POST", cookie, body: {} }))).status).toBe(200);
    expect((await listAppts(req("/api/appointments", { cookie }), noParams)).status).toBe(401);
  });

  it("uses one generic message for wrong passwords, unknown emails and inactive users", async () => {
    await prisma.user.update({ where: { id: viewer.id }, data: { isActive: false } });
    for (const [email, password] of [
      ["sales@test.local", "wrong-password1"],
      ["nobody@test.local", PASSWORD],
      ["viewer@test.local", PASSWORD],
    ]) {
      const res = await login(req("/api/auth/login", { method: "POST", body: { email, password }, headers: { "accept-language": "en-US,en;q=0.9" } }));
      expect(res.status).toBe(401);
      expect((await res.json()).error.message).toBe("Invalid email or password.");
    }
  });

  it("answers errors in the reader's language (cookie, then browser, then Arabic)", async () => {
    const body = { email: "nobody@test.local", password: PASSWORD };
    const ar = await login(req("/api/auth/login", { method: "POST", body }));
    expect((await ar.json()).error.message).toBe("البريد الإلكتروني أو كلمة المرور غير صحيحة.");
    const en = await login(req("/api/auth/login", { method: "POST", body, headers: { "accept-language": "en" } }));
    expect((await en.json()).error.message).toBe("Invalid email or password.");
    const cookie = await login(req("/api/auth/login", { method: "POST", body, cookie: "aura_locale=ar", headers: { "accept-language": "en" } }));
    expect((await cookie.json()).error.message).toBe("البريد الإلكتروني أو كلمة المرور غير صحيحة.");
  });

  it("rate-limits repeated failed logins", async () => {
    for (let i = 0; i < 5; i++) {
      await login(req("/api/auth/login", { method: "POST", body: { email: "sales@test.local", password: "bad-password1" } }));
    }
    const res = await login(req("/api/auth/login", { method: "POST", body: { email: "sales@test.local", password: PASSWORD } }));
    expect(res.status).toBe(429);
  });

  it("rejects cross-site state-changing requests", async () => {
    const cookie = await signIn("sales@test.local");
    const res = await createAppt(
      req("/api/appointments", { method: "POST", cookie, body: appointmentPayload(), headers: { origin: "https://evil.example" } }),
      noParams,
    );
    expect(res.status).toBe(403);
    expect(await prisma.appointment.count()).toBe(0);
  });

  it("returns 422 for malformed JSON", async () => {
    const cookie = await signIn("sales@test.local");
    const res = await createAppt(req("/api/appointments", { method: "POST", cookie, body: "{not json" }), noParams);
    expect(res.status).toBe(422);
  });
});

describe("authorization through the API", () => {
  it("lets Sales create; returns 409 with conflict details on double booking", async () => {
    const cookie = await signIn("sales@test.local");
    const res = await createAppt(req("/api/appointments", { method: "POST", cookie, body: appointmentPayload({ technicianIds: [tech.id] }) }), noParams);
    expect(res.status).toBe(201);
    const { appointment } = await res.json();
    expect(appointment.createdBy.id).toBe(sales.id);

    const avail = await availability(
      req("/api/appointments/availability", { method: "POST", cookie, body: { date: "2030-03-10", startTime: "11:00", durationMinutes: 60 } }),
      noParams,
    );
    const { technicians } = await avail.json();
    expect(technicians.find((t: { id: string }) => t.id === tech.id).available).toBe(false);
    expect(technicians.find((t: { id: string }) => t.id === otherTech.id).available).toBe(true);

    const clash = await createAppt(
      req("/api/appointments", { method: "POST", cookie, body: appointmentPayload({ startTime: "11:00", technicianIds: [tech.id] }) }),
      noParams,
    );
    expect(clash.status).toBe(409);
    const body = await clash.json();
    expect(body.error.code).toBe("SCHEDULING_CONFLICT");
    expect(body.error.conflicts[0].technicianId).toBe(tech.id);
  });

  it("ignores a creator or role sent by the browser", async () => {
    const cookie = await signIn("sales@test.local");
    const res = await createAppt(
      req("/api/appointments", { method: "POST", cookie, body: { ...appointmentPayload(), createdById: otherTech.id, role: "ADMIN" } }),
      noParams,
    );
    expect((await res.json()).appointment.createdBy.id).toBe(sales.id);
  });

  it("technicians cannot modify appointments or see other technicians' jobs via direct API calls", async () => {
    const salesCookie = await signIn("sales@test.local");
    const mine = (await (await createAppt(req("/api/appointments", { method: "POST", cookie: salesCookie, body: appointmentPayload({ technicianIds: [tech.id] }) }), noParams)).json()).appointment;
    const theirs = (await (await createAppt(req("/api/appointments", { method: "POST", cookie: salesCookie, body: appointmentPayload({ technicianIds: [otherTech.id] }) }), noParams)).json()).appointment;

    const cookie = await signIn("tech@test.local");
    expect((await getAppt(req(`/api/appointments/${mine.id}`, { cookie }), idParams(mine.id))).status).toBe(200);
    expect((await getAppt(req(`/api/appointments/${theirs.id}`, { cookie }), idParams(theirs.id))).status).toBe(404);
    const patch = await patchAppt(
      req(`/api/appointments/${mine.id}`, { method: "PATCH", cookie, body: appointmentPayload({ startTime: "18:00", technicianIds: [tech.id] }) }),
      idParams(mine.id),
    );
    expect(patch.status).toBe(403);
    expect((await cancelAppt(req(`/api/appointments/${mine.id}/cancel`, { method: "POST", cookie, body: {} }), idParams(mine.id))).status).toBe(403);
    expect((await createAppt(req("/api/appointments", { method: "POST", cookie, body: appointmentPayload() }), noParams)).status).toBe(403);
  });

  it("viewers and sales cannot create users; reports are permission-gated", async () => {
    for (const email of ["viewer@test.local", "sales@test.local"]) {
      const cookie = await signIn(email);
      const res = await createUserRoute(
        req("/api/users", { method: "POST", cookie, body: { name: "Hacker", email: "h@test.local", role: "ADMIN" } }),
        noParams,
      );
      expect(res.status).toBe(403);
    }
    const viewerCookie = await signIn("viewer@test.local");
    expect((await exportCsv(req("/api/reports/export?type=status&from=2030-01-01&to=2030-01-31", { cookie: viewerCookie }), noParams)).status).toBe(403);
    const salesCookie = await signIn("sales@test.local");
    const csv = await exportCsv(req("/api/reports/export?type=status&from=2030-01-01&to=2030-01-31", { cookie: salesCookie }), noParams);
    expect(csv.status).toBe(200);
    expect(csv.headers.get("content-type")).toContain("text/csv");
  });

  it("admin can create a technician who is immediately assignable", async () => {
    const cookie = await signIn("admin@test.local");
    const res = await createUserRoute(
      req("/api/users", { method: "POST", cookie, body: { name: "Fresh Tech", email: "fresh@test.local", role: "TECHNICIAN" } }),
      noParams,
    );
    expect(res.status).toBe(201);
    const { user } = await res.json();
    const salesCookie = await signIn("sales@test.local");
    const created = await createAppt(
      req("/api/appointments", { method: "POST", cookie: salesCookie, body: appointmentPayload({ technicianIds: [user.id] }) }),
      noParams,
    );
    expect(created.status).toBe(201);
  });
});
