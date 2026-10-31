/**
 * Exercises the real Next.js route handlers (authentication cookie -> session -> permission
 * checks -> JSON errors) without a browser.
 */
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { User } from "@prisma/client";
import { POST as login } from "@/app/api/auth/login/route";
import { POST as logout } from "@/app/api/auth/logout/route";
import { POST as setLocale } from "@/app/api/me/locale/route";
import { GET as listAppts, POST as createAppt } from "@/app/api/appointments/route";
import { GET as getAppt, PATCH as patchAppt } from "@/app/api/appointments/[id]/route";
import { POST as cancelAppt } from "@/app/api/appointments/[id]/cancel/route";
import { POST as createUserRoute } from "@/app/api/users/route";
import { POST as availability } from "@/app/api/appointments/availability/route";
import { GET as exportCsv } from "@/app/api/reports/export/route";
import { GET as listFiles, POST as uploadFile } from "@/app/api/appointments/[id]/attachments/route";
import { DELETE as removeFile, GET as getFile } from "@/app/api/attachments/[id]/route";
import { PUT as putChecklist } from "@/app/api/appointments/[id]/checklist/route";
import { POST as openComplaintRoute } from "@/app/api/appointments/[id]/complaints/route";
import { PATCH as patchComplaint } from "@/app/api/complaints/[id]/route";
import { PUT as putRating } from "@/app/api/appointments/[id]/rating/route";
import { MAX_UPLOAD_BYTES } from "@/server/storage";
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
      const res = await login(req("/api/auth/login", { method: "POST", body: { email, password }, cookie: "ims_locale=en" }));
      expect(res.status).toBe(401);
      expect((await res.json()).error.message).toBe("Invalid email or password.");
    }
  });

  it("answers in Arabic unless English was chosen", async () => {
    const body = { email: "sales@test.local", password: "wrong-password1" };
    const arabic = await login(req("/api/auth/login", { method: "POST", body }));
    expect((await arabic.json()).error.message).toBe("البريد الإلكتروني أو كلمة المرور غير صحيحة.");
    const english = await login(req("/api/auth/login", { method: "POST", body, cookie: "ims_locale=en" }));
    expect((await english.json()).error.message).toBe("Invalid email or password.");
  });

  it("remembers the chosen language for the signed-in user", async () => {
    const cookie = await signIn("sales@test.local");
    const res = await setLocale(req("/api/me/locale", { method: "POST", cookie, body: { locale: "en" } }));
    expect(res.status).toBe(200);
    expect(res.headers.get("set-cookie")).toMatch(/ims_locale=en/);
    expect((await prisma.user.findUniqueOrThrow({ where: { email: "sales@test.local" } })).locale).toBe("en");
    const bad = await setLocale(req("/api/me/locale", { method: "POST", cookie, body: { locale: "fr" } }));
    expect(bad.status).toBe(422);
    // Signing in again on a browser without a language restores it...
    const again = await login(req("/api/auth/login", { method: "POST", body: { email: "sales@test.local", password: PASSWORD } }));
    expect(again.headers.get("set-cookie")).toMatch(/ims_locale=en/);
    // ...but a language already chosen in the browser is kept.
    const chosen = await login(req("/api/auth/login", { method: "POST", body: { email: "sales@test.local", password: PASSWORD }, cookie: "ims_locale=ar" }));
    expect(chosen.status).toBe(200);
    expect(chosen.headers.get("set-cookie")).not.toMatch(/ims_locale=/);
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

describe("visit photos through the API", () => {
  let dir: string;
  beforeAll(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), "ims-api-uploads-"));
    process.env.UPLOAD_DIR = dir;
  });
  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]);
  function upload(id: string, kind: string, body: BodyInit, cookie: string, headers: Record<string, string> = {}) {
    return uploadFile(
      new Request(`${BASE}/api/appointments/${id}/attachments?kind=${kind}`, { method: "POST", headers: { host: "localhost:3000", cookie, "content-type": "image/jpeg", ...headers }, body }),
      idParams(id),
    );
  }

  it("uploads raw image bytes, serves them only to allowed readers and refuses oversized or cross-site uploads", async () => {
    const salesCookie = await signIn("sales@test.local");
    const appt = (await (await createAppt(req("/api/appointments", { method: "POST", cookie: salesCookie, body: appointmentPayload({ technicianIds: [tech.id], visitType: "INSTALLATION" }) }), noParams)).json()).appointment;
    const cookie = await signIn("tech@test.local");

    const res = await upload(appt.id, "AFTER_PHOTO", JPEG, cookie);
    expect(res.status).toBe(200);
    const { attachment } = await res.json();
    expect(attachment).toMatchObject({ kind: "AFTER_PHOTO", url: `/api/attachments/${attachment.id}`, canDelete: true });

    const file = await getFile(req(attachment.url, { cookie }), idParams(attachment.id));
    expect(file.status).toBe(200);
    expect(file.headers.get("content-type")).toBe("image/jpeg");
    expect(file.headers.get("cache-control")).toBe("private, max-age=31536000, immutable");
    expect(new Uint8Array(await file.arrayBuffer())).toEqual(JPEG);
    const otherCookie = await signIn("tech2@test.local");
    expect((await getFile(req(attachment.url, { cookie: otherCookie }), idParams(attachment.id))).status).toBe(404);
    expect((await getFile(req(attachment.url), idParams(attachment.id))).status).toBe(401);

    const list = await (await listFiles(req(`/api/appointments/${appt.id}/attachments`, { cookie }), idParams(appt.id))).json();
    expect(list.items).toHaveLength(1);

    const tooBig = await upload(appt.id, "AFTER_PHOTO", JPEG, cookie, { "content-length": String(MAX_UPLOAD_BYTES + 1) });
    expect(tooBig.status).toBe(422);
    const crossSite = await upload(appt.id, "AFTER_PHOTO", JPEG, cookie, { origin: "https://evil.example" });
    expect(crossSite.status).toBe(403);
    const svg = await upload(appt.id, "AFTER_PHOTO", new TextEncoder().encode("<svg/>"), cookie, { "content-type": "image/svg+xml" });
    expect(svg.status).toBe(422);

    const checklist = await putChecklist(req(`/api/appointments/${appt.id}/checklist`, { method: "PUT", cookie, body: { items: ["lock.door"] } }), idParams(appt.id));
    expect(await checklist.json()).toEqual({ items: ["lock.door"] });

    expect((await removeFile(req(attachment.url, { method: "DELETE", cookie: otherCookie }), idParams(attachment.id))).status).toBe(404);
    expect((await removeFile(req(attachment.url, { method: "DELETE", cookie }), idParams(attachment.id))).status).toBe(200);
    expect((await getFile(req(attachment.url, { cookie }), idParams(attachment.id))).status).toBe(404);
  });
});

describe("complaints and ratings through the API", () => {
  it("opens a complaint (201), refuses technicians, and answers in the reader's language", async () => {
    const salesCookie = await signIn("sales@test.local");
    const appt = (await (await createAppt(req("/api/appointments", { method: "POST", cookie: salesCookie, body: appointmentPayload({ technicianIds: [tech.id] }) }), noParams)).json()).appointment;

    const opened = await openComplaintRoute(req(`/api/appointments/${appt.id}/complaints`, { method: "POST", cookie: salesCookie, body: { description: "Lock beeps" } }), idParams(appt.id));
    expect(opened.status).toBe(201);
    const { complaint } = await opened.json();
    expect(complaint.code).toMatch(/^C\d{4}-001$/);

    const techCookie = await signIn("tech@test.local");
    expect((await openComplaintRoute(req(`/api/appointments/${appt.id}/complaints`, { method: "POST", cookie: techCookie, body: { description: "x" } }), idParams(appt.id))).status).toBe(403);
    const empty = await openComplaintRoute(req(`/api/appointments/${appt.id}/complaints`, { method: "POST", cookie: salesCookie, body: { description: "" } }), idParams(appt.id));
    expect(empty.status).toBe(422);
    expect((await empty.json()).error.fieldErrors.description).toMatch(/مطلوب|required/);

    const close = await patchComplaint(req(`/api/complaints/${complaint.id}`, { method: "PATCH", cookie: salesCookie, body: { action: "close", version: complaint.version } }), idParams(complaint.id));
    expect((await close.json()).complaint.status).toBe("CLOSED");
    const stale = await patchComplaint(req(`/api/complaints/${complaint.id}`, { method: "PATCH", cookie: salesCookie, body: { action: "reopen", version: complaint.version } }), idParams(complaint.id));
    expect(stale.status).toBe(409);

    // The visit has not happened yet: no rating.
    expect((await putRating(req(`/api/appointments/${appt.id}/rating`, { method: "PUT", cookie: salesCookie, body: { rating: 5, note: null } }), idParams(appt.id))).status).toBe(422);
  });
});
