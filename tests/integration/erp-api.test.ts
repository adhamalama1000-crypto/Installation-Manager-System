/**
 * The work evidence and penalty routes through the real Next.js route handlers (session cookie ->
 * permission checks -> JSON errors), without a browser: who may call what, and what they get back.
 */
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { User } from "@prisma/client";
import { POST as login } from "@/app/api/auth/login/route";
import { POST as createAppt } from "@/app/api/appointments/route";
import { POST as uploadFile } from "@/app/api/appointments/[id]/attachments/route";
import { GET as getFile } from "@/app/api/attachments/[id]/route";
import { GET as evidenceStatus } from "@/app/api/appointments/[id]/evidence/route";
import { POST as decideWork } from "@/app/api/appointments/[id]/evidence/decision/route";
import { POST as resubmitWork } from "@/app/api/appointments/[id]/evidence/resubmit/route";
import { POST as outcome } from "@/app/api/appointments/[id]/outcome/route";
import { GET as evidenceQueue } from "@/app/api/evidence/queue/route";
import { GET as listRules, PUT as putRule } from "@/app/api/evidence/rules/route";
import { GET as listViolations, POST as recordViolation } from "@/app/api/penalties/route";
import { GET as getViolation } from "@/app/api/penalties/[id]/route";
import { POST as decideViolation } from "@/app/api/penalties/[id]/decision/route";
import { POST as cancelViolation } from "@/app/api/penalties/[id]/cancel/route";
import { POST as scan } from "@/app/api/penalties/scan/route";
import { GET as listPenaltyRules, POST as createPenaltyRule } from "@/app/api/penalties/rules/route";
import { PATCH as patchPenaltyRule } from "@/app/api/penalties/rules/[id]/route";
import { hashPassword } from "@/server/auth/password";
import { appointmentPayload, makeUser, prisma, resetDb, seedStatuses } from "../helpers";

const BASE = "http://localhost:3000";
const PASSWORD = "Password123";
const noParams = { params: Promise.resolve({}) };
const idParams = (id: string) => ({ params: Promise.resolve({ id }) });

function req(p: string, init: { method?: string; body?: unknown; cookie?: string; headers?: Record<string, string> } = {}) {
  const headers: Record<string, string> = { host: "localhost:3000", ...(init.headers ?? {}) };
  if (init.cookie) headers.cookie = init.cookie;
  if (init.body !== undefined) headers["content-type"] = "application/json";
  return new Request(`${BASE}${p}`, { method: init.method ?? "GET", headers, body: init.body === undefined ? undefined : JSON.stringify(init.body) });
}

async function signIn(email: string): Promise<string> {
  const res = await login(req("/api/auth/login", { method: "POST", body: { email, password: PASSWORD } }));
  expect(res.status).toBe(200);
  return res.headers.get("set-cookie")!.split(";")[0]!;
}

let tech: User;
let cookies: Record<"admin" | "sales" | "tech" | "otherTech" | "accountant" | "viewer", string>;

beforeEach(async () => {
  await resetDb();
  await seedStatuses();
  const passwordHash = await hashPassword(PASSWORD);
  await makeUser("ADMIN", { email: "admin@test.local", passwordHash });
  await makeUser("SALES", { email: "sales@test.local", passwordHash });
  tech = await makeUser("TECHNICIAN", { email: "tech@test.local", passwordHash });
  await makeUser("TECHNICIAN", { email: "tech2@test.local", passwordHash });
  await makeUser("ACCOUNTANT", { email: "acc@test.local", passwordHash });
  await makeUser("VIEWER", { email: "viewer@test.local", passwordHash, viewerPermissions: ["appointments.view"] });
  cookies = {
    admin: await signIn("admin@test.local"),
    sales: await signIn("sales@test.local"),
    tech: await signIn("tech@test.local"),
    otherTech: await signIn("tech2@test.local"),
    accountant: await signIn("acc@test.local"),
    viewer: await signIn("viewer@test.local"),
  };
});

describe("work evidence routes", () => {
  let dir: string;
  beforeAll(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), "ims-erp-api-"));
    process.env.UPLOAD_DIR = dir;
  });
  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  const MP4 = new Uint8Array([0, 0, 0, 0x18, ...Array.from("ftypmp42", (c) => c.charCodeAt(0)), 0, 0, 0, 0, ...Array.from("mp42isom", (c) => c.charCodeAt(0)), 1, 2, 3, 4, 5, 6, 7, 8]);
  const upload = (id: string, kind: string, body: BodyInit, cookie: string, type = "video/mp4") =>
    uploadFile(new Request(`${BASE}/api/appointments/${id}/attachments?kind=${kind}`, { method: "POST", headers: { host: "localhost:3000", cookie, "content-type": type }, body }), idParams(id));

  it("lets Admins set rules, refuses everyone else, and runs the review through the API", async () => {
    const rule = { visitType: "INSTALLATION", productCategory: "SMART_LOCK", minAfterPhotos: 0, requireVideo: true, requireReview: true };
    expect((await putRule(req("/api/evidence/rules", { method: "PUT", body: rule }), noParams)).status).toBe(401);
    expect((await putRule(req("/api/evidence/rules", { method: "PUT", cookie: cookies.sales, body: rule }), noParams)).status).toBe(403);
    expect((await listRules(req("/api/evidence/rules", { cookie: cookies.tech }), noParams)).status).toBe(404);
    expect((await putRule(req("/api/evidence/rules", { method: "PUT", cookie: cookies.admin, body: { ...rule, minAfterPhotos: 99 } }), noParams)).status).toBe(422);
    expect((await putRule(req("/api/evidence/rules", { method: "PUT", cookie: cookies.admin, body: rule }), noParams)).status).toBe(200);

    const appt = (await (await createAppt(req("/api/appointments", { method: "POST", cookie: cookies.sales, body: appointmentPayload({ technicianIds: [tech.id], visitType: "INSTALLATION" }) }), noParams)).json()).appointment;
    const done = { outcome: "COMPLETED", report: "Installed" };
    const refused = await outcome(req(`/api/appointments/${appt.id}/outcome`, { method: "POST", cookie: cookies.tech, body: done }), idParams(appt.id));
    expect(refused.status).toBe(422);
    // In Arabic: the API answers in the reader's language, Arabic unless English was chosen.
    expect((await refused.json()).error.fieldErrors.outcome).toBe("فيديو للشغل");

    // A video, streamed in ranges to readers who may see the visit only.
    const up = await upload(appt.id, "VIDEO", MP4, cookies.tech);
    expect(up.status).toBe(200);
    const { attachment } = await up.json();
    const part = await getFile(req(attachment.url, { cookie: cookies.sales, headers: { range: "bytes=4-11" } }), idParams(attachment.id));
    expect(part.status).toBe(206);
    expect(part.headers.get("content-range")).toBe(`bytes 4-11/${MP4.byteLength}`);
    expect(part.headers.get("accept-ranges")).toBe("bytes");
    expect(new TextDecoder().decode(await part.arrayBuffer())).toBe("ftypmp42");
    const whole = await getFile(req(attachment.url, { cookie: cookies.sales }), idParams(attachment.id));
    expect([whole.status, Number(whole.headers.get("content-length"))]).toEqual([200, MP4.byteLength]);
    expect((await getFile(req(attachment.url, { cookie: cookies.sales, headers: { range: "bytes=999-" } }), idParams(attachment.id))).status).toBe(416);
    expect((await getFile(req(attachment.url, { cookie: cookies.otherTech }), idParams(attachment.id))).status).toBe(404);
    // A photo sent as a video, or a video as a photo, is refused.
    expect((await upload(appt.id, "VIDEO", new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2]), cookies.tech, "image/jpeg")).status).toBe(422);
    expect((await upload(appt.id, "AFTER_PHOTO", MP4, cookies.tech)).status).toBe(422);

    expect((await outcome(req(`/api/appointments/${appt.id}/outcome`, { method: "POST", cookie: cookies.tech, body: done }), idParams(appt.id))).status).toBe(200);
    const status = await (await evidenceStatus(req(`/api/appointments/${appt.id}/evidence`, { cookie: cookies.tech }), idParams(appt.id))).json();
    expect(status.evidence).toMatchObject({ status: "SUBMITTED", can: { review: false, resubmit: false } });
    expect((await evidenceStatus(req(`/api/appointments/${appt.id}/evidence`, { cookie: cookies.otherTech }), idParams(appt.id))).status).toBe(404);

    expect((await evidenceQueue(req("/api/evidence/queue", { cookie: cookies.sales }), noParams)).status).toBe(403);
    expect((await (await evidenceQueue(req("/api/evidence/queue", { cookie: cookies.admin }), noParams)).json()).rows).toHaveLength(1);
    expect((await decideWork(req(`/api/appointments/${appt.id}/evidence/decision`, { method: "POST", cookie: cookies.tech, body: { decision: "APPROVED" } }), idParams(appt.id))).status).toBe(403);
    expect((await decideWork(req(`/api/appointments/${appt.id}/evidence/decision`, { method: "POST", cookie: cookies.admin, body: { decision: "REJECTED" } }), idParams(appt.id))).status).toBe(422);
    expect((await decideWork(req(`/api/appointments/${appt.id}/evidence/decision`, { method: "POST", cookie: cookies.admin, body: { decision: "REJECTED", note: "Too dark" } }), idParams(appt.id))).status).toBe(200);
    expect((await resubmitWork(req(`/api/appointments/${appt.id}/evidence/resubmit`, { method: "POST", cookie: cookies.otherTech, body: {} }), idParams(appt.id))).status).toBe(404);
    const again = await resubmitWork(req(`/api/appointments/${appt.id}/evidence/resubmit`, { method: "POST", cookie: cookies.tech, body: { note: "Re-shot" } }), idParams(appt.id));
    expect((await again.json()).evidence.status).toBe("SUBMITTED");
  });
});

describe("penalty routes", () => {
  it("only those with the rights record, find, decide and cancel; employees see their own decided ones", async () => {
    const lateRule = { name: "Late", trigger: "LATE_ARRIVAL", action: "FIXED", amount: "50" };
    expect((await createPenaltyRule(req("/api/penalties/rules", { method: "POST", cookie: cookies.accountant, body: lateRule }), noParams)).status).toBe(403);
    const created = await createPenaltyRule(req("/api/penalties/rules", { method: "POST", cookie: cookies.admin, body: lateRule }), noParams);
    expect(created.status).toBe(201);
    const { rule } = await created.json();
    expect((await patchPenaltyRule(req(`/api/penalties/rules/${rule.id}`, { method: "PATCH", cookie: cookies.admin, body: { ...lateRule, amount: "" } }), idParams(rule.id))).status).toBe(422);
    expect((await (await listPenaltyRules(req("/api/penalties/rules", { cookie: cookies.accountant }), noParams)).json()).rules).toHaveLength(1);
    expect((await listPenaltyRules(req("/api/penalties/rules", { cookie: cookies.tech }), noParams)).status).toBe(404);

    expect((await scan(req("/api/penalties/scan", { method: "POST", cookie: cookies.accountant, body: { from: "2026-01-01", to: "2026-01-02" } }), noParams)).status).toBe(403);
    expect((await scan(req("/api/penalties/scan", { method: "POST", cookie: cookies.admin, body: { from: "2026-01-05", to: "2026-01-01" } }), noParams)).status).toBe(422);

    const body = { userId: tech.id, occurredOn: "2026-01-04", kind: "DEDUCTION", amount: "120", description: "Damaged the customer's door frame" };
    expect((await recordViolation(req("/api/penalties", { method: "POST", body }), noParams)).status).toBe(401);
    expect((await recordViolation(req("/api/penalties", { method: "POST", cookie: cookies.sales, body }), noParams)).status).toBe(403);
    const rec = await recordViolation(req("/api/penalties", { method: "POST", cookie: cookies.admin, body }), noParams);
    expect(rec.status).toBe(201);
    const { violation } = await rec.json();

    // Proposed: invisible to the employee, decided by an approver only.
    expect((await (await listViolations(req("/api/penalties", { cookie: cookies.tech }), noParams)).json()).rows).toEqual([]);
    expect((await getViolation(req(`/api/penalties/${violation.id}`, { cookie: cookies.tech }), idParams(violation.id))).status).toBe(404);
    expect((await listViolations(req("/api/penalties", { cookie: cookies.viewer }), noParams)).status).toBe(404);
    expect((await decideViolation(req(`/api/penalties/${violation.id}/decision`, { method: "POST", cookie: cookies.accountant, body: { decision: "APPROVED" } }), idParams(violation.id))).status).toBe(403);
    expect((await decideViolation(req(`/api/penalties/${violation.id}/decision`, { method: "POST", cookie: cookies.admin, body: { decision: "REJECTED" } }), idParams(violation.id))).status).toBe(422);
    const ok = await decideViolation(req(`/api/penalties/${violation.id}/decision`, { method: "POST", cookie: cookies.admin, body: { decision: "APPROVED", note: "Photos confirm it" } }), idParams(violation.id));
    expect((await ok.json()).violation).toMatchObject({ status: "APPROVED", kind: "DEDUCTION", amount: 120 });

    const mine = await (await listViolations(req("/api/penalties", { cookie: cookies.tech }), noParams)).json();
    expect(mine.rows.map((r: { number: string; status: string }) => r.status)).toEqual(["APPROVED"]);
    const detail = await (await getViolation(req(`/api/penalties/${violation.id}`, { cookie: cookies.tech }), idParams(violation.id))).json();
    expect(detail.violation.entries).toEqual([expect.objectContaining({ kind: "APPROVAL", month: "2026-01", amount: 120 })]);
    expect((await (await listViolations(req("/api/penalties", { cookie: cookies.otherTech }), noParams)).json()).rows).toEqual([]);

    expect((await cancelViolation(req(`/api/penalties/${violation.id}/cancel`, { method: "POST", cookie: cookies.tech, body: { reason: "no" } }), idParams(violation.id))).status).toBe(403);
    expect((await cancelViolation(req(`/api/penalties/${violation.id}/cancel`, { method: "POST", cookie: cookies.admin, body: {} }), idParams(violation.id))).status).toBe(422);
    expect((await cancelViolation(req(`/api/penalties/${violation.id}/cancel`, { method: "POST", cookie: cookies.admin, body: { reason: "Frame was already cracked" } }), idParams(violation.id))).status).toBe(200);
    expect((await prisma.deductionEntry.aggregate({ _sum: { amount: true } }))._sum.amount?.toNumber()).toBe(0);
  });
});
