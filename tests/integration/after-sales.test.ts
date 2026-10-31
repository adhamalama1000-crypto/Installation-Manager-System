import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { User } from "@prisma/client";
import { createAppointment, getAppointment, getAppointmentHistory, recordVisitOutcome } from "@/server/services/appointments";
import { afterSalesList, getFeedback, recordMaintenanceCall, setCustomerRating, setQualityGrade } from "@/server/services/after-sales";
import { uploadAttachment } from "@/server/services/attachments";
import { getComplaint, listComplaints, openComplaint, updateComplaint } from "@/server/services/complaints";
import { dashboardSummary } from "@/server/services/dashboard";
import { listNotifications } from "@/server/services/notifications";
import { moveStock, saveModel, stockIn } from "@/server/services/stock";
import { DEFAULT_TIMEZONE } from "@/lib/constants";
import { addDaysToKey, todayKey } from "@/lib/time";
import { ForbiddenError, NotFoundError, StaleRecordError, ValidationError } from "@/server/errors";
import { appointmentPayload, asCurrent, makeUser, prisma, resetDb, seedStatuses } from "../helpers";

let admin: User, sales: User, otherSales: User, tech: User, otherTech: User, viewer: User, store: User;
let dir: string;
const today = todayKey(DEFAULT_TIMEZONE);
const daysAgo = (n: number) => addDaysToKey(today, -n);

beforeAll(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), "ims-after-sales-"));
  process.env.UPLOAD_DIR = dir;
});
afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

beforeEach(async () => {
  await resetDb();
  await seedStatuses();
  admin = await makeUser("ADMIN");
  sales = await makeUser("SALES");
  otherSales = await makeUser("SALES");
  tech = await makeUser("TECHNICIAN");
  otherTech = await makeUser("TECHNICIAN");
  viewer = await makeUser("VIEWER", { viewerPermissions: ["appointments.view"] });
  store = await makeUser("STORE");
});

let seq = 0;
async function book(overrides: Record<string, unknown> = {}) {
  seq++;
  return createAppointment(asCurrent(sales), appointmentPayload({ technicianIds: [tech.id], visitType: "INSTALLATION", startTime: `${String(8 + (seq % 10)).padStart(2, "0")}:00`, durationMinutes: 30, ...overrides }));
}

async function done(a: { id: string; version: number }, by: User = tech, report = "Installed") {
  return recordVisitOutcome(asCurrent(by), a.id, { outcome: "COMPLETED", report, version: a.version });
}

describe("complaints", () => {
  it("lets Sales open a complaint on their visit with Aura's number and the warranty, and tells the Admins", async () => {
    const model = await saveModel(asCurrent(store), null, { name: "Lock X", category: "SMART_LOCK", warrantyMonths: 12 });
    await stockIn(asCurrent(store), { modelId: model.id, serials: "LX-1" });
    const item = await prisma.stockItem.findFirstOrThrow({ where: { serial: "LX-1" } });
    await moveStock(asCurrent(store), { itemIds: [item.id], to: "WITH_TECHNICIAN", technicianId: tech.id });
    const a = await book({ date: daysAgo(20) });
    await recordVisitOutcome(asCurrent(tech), a.id, { outcome: "COMPLETED", report: "Installed", serials: "LX-1", version: a.version });

    const c = await openComplaint(asCurrent(sales), a.id, { description: "  The fingerprint reader stopped working  " });
    const prefix = `C${today.slice(2, 4)}${today.slice(5, 7)}-`;
    expect(c).toMatchObject({ code: `${prefix}001`, status: "NEW", description: "The fingerprint reader stopped working", assignedTo: null });
    expect(c.warrantyUntil! > today).toBe(true);
    expect((await openComplaint(asCurrent(admin), a.id, { description: "Second issue" })).code).toBe(`${prefix}002`);

    expect((await listNotifications(asCurrent(admin))).items.some((n) => n.type === "COMPLAINT" && n.appointmentId === a.id)).toBe(true);
    expect((await getAppointmentHistory(asCurrent(sales), a.id)).some((h) => h.action === "COMPLAINT_OPENED")).toBe(true);

    await expect(openComplaint(asCurrent(sales), a.id, { description: "   " })).rejects.toBeInstanceOf(ValidationError);
    await expect(openComplaint(asCurrent(tech), a.id, { description: "x" })).rejects.toBeInstanceOf(ForbiddenError);
    await expect(openComplaint(asCurrent(otherSales, { salesCanEditOthersAppointments: false }), a.id, { description: "x" })).rejects.toBeInstanceOf(ForbiddenError);
    await expect(openComplaint(asCurrent(viewer), a.id, { description: "x" })).rejects.toBeInstanceOf(ForbiddenError);
    // A technician who was not on the visit cannot even see it.
    await expect(openComplaint(asCurrent(otherTech), a.id, { description: "x" })).rejects.toBeInstanceOf(NotFoundError);
    await expect(prisma.$executeRaw`DELETE FROM complaints WHERE id = ${c.id}`).rejects.toThrow(/cannot be deleted/);
  });

  it("goes from assigned to resolved by the technician, closed by Sales and reopened", async () => {
    const a = await done(await book({ date: daysAgo(10) }));
    let c = await openComplaint(asCurrent(sales), a.id, { description: "Door does not lock" });
    expect(c.rights).toEqual({ assign: false, linkVisit: false, resolve: false, close: true, reopen: false });

    await expect(updateComplaint(asCurrent(sales), c.id, { action: "assign", technicianId: otherTech.id, version: c.version })).rejects.toBeInstanceOf(ForbiddenError);
    await expect(updateComplaint(asCurrent(admin), c.id, { action: "assign", technicianId: store.id, version: c.version })).rejects.toBeInstanceOf(ValidationError);
    c = await updateComplaint(asCurrent(admin), c.id, { action: "assign", technicianId: otherTech.id, version: c.version });
    expect(c).toMatchObject({ status: "ASSIGNED", assignedTo: { id: otherTech.id } });
    expect((await listNotifications(asCurrent(otherTech))).items.some((n) => n.type === "COMPLAINT")).toBe(true);

    // Technicians only see the complaints assigned to them.
    expect((await listComplaints(asCurrent(otherTech), {})).items.map((x) => x.id)).toEqual([c.id]);
    expect((await listComplaints(asCurrent(tech), {})).items).toHaveLength(0);
    await expect(getComplaint(asCurrent(tech), c.id)).rejects.toBeInstanceOf(NotFoundError);
    const seen = await getComplaint(asCurrent(otherTech), c.id);
    expect(seen.rights).toEqual({ assign: false, linkVisit: false, resolve: true, close: false, reopen: false });
    expect(seen.appointment.canOpen).toBe(false);

    await expect(updateComplaint(asCurrent(otherTech), c.id, { action: "resolve", resolution: "  ", version: c.version })).rejects.toBeInstanceOf(ValidationError);
    c = await updateComplaint(asCurrent(otherTech), c.id, { action: "resolve", resolution: "Adjusted the strike plate", version: c.version });
    expect(c).toMatchObject({ status: "RESOLVED", resolution: "Adjusted the strike plate", resolvedBy: { id: otherTech.id } });
    expect((await listNotifications(asCurrent(sales))).items.some((n) => n.type === "COMPLAINT")).toBe(true);
    await expect(updateComplaint(asCurrent(otherTech), c.id, { action: "close", version: c.version })).rejects.toBeInstanceOf(ForbiddenError);

    await expect(updateComplaint(asCurrent(sales), c.id, { action: "close", version: c.version - 1 })).rejects.toBeInstanceOf(StaleRecordError);
    c = await updateComplaint(asCurrent(sales), c.id, { action: "close", version: c.version });
    expect(c).toMatchObject({ status: "CLOSED", closedBy: { id: sales.id } });
    expect((await listComplaints(asCurrent(otherTech), {})).items).toHaveLength(0);
    expect((await listComplaints(asCurrent(sales), {})).items).toHaveLength(0);
    expect((await listComplaints(asCurrent(sales), { status: "CLOSED" })).items).toHaveLength(1);

    c = await updateComplaint(asCurrent(sales), c.id, { action: "reopen", version: c.version });
    expect(c).toMatchObject({ status: "ASSIGNED", closedAt: null, resolution: "Adjusted the strike plate" });
    const history = await prisma.auditLog.findMany({ where: { entityType: "COMPLAINT", entityId: c.id }, orderBy: { createdAt: "asc" } });
    expect(history.map((h) => h.action)).toEqual(["COMPLAINT_OPENED", "COMPLAINT_ASSIGNED", "COMPLAINT_RESOLVED", "COMPLAINT_CLOSED", "COMPLAINT_REOPENED"]);
  });

  it("is resolved by finishing the maintenance visit linked to it", async () => {
    const a = await done(await book({ date: daysAgo(30) }));
    let c = await openComplaint(asCurrent(sales), a.id, { description: "App does not connect" });
    const other = await createAppointment(asCurrent(sales), appointmentPayload({ customer: { name: "Someone Else", phone: "+20 100 999 8888" }, technicianIds: [], date: daysAgo(1) }));
    await expect(updateComplaint(asCurrent(admin), c.id, { action: "linkVisit", visitId: other.id, version: c.version })).rejects.toBeInstanceOf(ValidationError);
    await expect(updateComplaint(asCurrent(admin), c.id, { action: "linkVisit", visitId: a.id, version: c.version })).rejects.toBeInstanceOf(ValidationError);

    const visit = await book({
      date: addDaysToKey(today, 2),
      visitType: "MAINTENANCE",
      technicianIds: [otherTech.id],
      followUpOfId: a.id,
      customer: { id: a.customer.id, name: a.customer.name, phone: "+20 100 123 4567" },
    });
    c = await updateComplaint(asCurrent(admin), c.id, { action: "linkVisit", visitId: visit.id, version: c.version });
    expect(c.visit).toMatchObject({ id: visit.id, canOpen: true });
    expect((await getComplaint(asCurrent(sales), c.id)).status).toBe("NEW");

    await recordVisitOutcome(asCurrent(otherTech), visit.id, { outcome: "COMPLETED", report: "Re-paired the hub, app works", version: visit.version });
    const resolved = await getComplaint(asCurrent(sales), c.id);
    expect(resolved).toMatchObject({ status: "RESOLVED", resolution: "Re-paired the hub, app works", resolvedBy: { id: otherTech.id } });
    expect((await listNotifications(asCurrent(sales))).items.some((n) => n.type === "COMPLAINT")).toBe(true);
  });
});

describe("ratings, quality grades and maintenance calls", () => {
  it("records the customer's rating on a finished visit without touching the booking version", async () => {
    const scheduled = await book({ date: addDaysToKey(today, 3) });
    await expect(setCustomerRating(asCurrent(sales), scheduled.id, { rating: 5, note: null })).rejects.toBeInstanceOf(ValidationError);
    const a = await done(await book({ date: daysAgo(5) }));
    await expect(setCustomerRating(asCurrent(sales), a.id, { rating: 6, note: null })).rejects.toBeInstanceOf(ValidationError);
    await expect(setCustomerRating(asCurrent(tech), a.id, { rating: 5, note: null })).rejects.toBeInstanceOf(ForbiddenError);
    expect(await setCustomerRating(asCurrent(sales), a.id, { rating: 4, note: "  Happy, a bit late  " })).toEqual({ rating: 4, note: "Happy, a bit late" });
    const f = await getFeedback(asCurrent(tech), a.id);
    expect(f).toMatchObject({ rating: 4, ratingNote: "Happy, a bit late", ratedBy: { id: sales.id }, rights: { rate: false, grade: false, call: false } });
    expect((await getAppointment(asCurrent(sales), a.id)).version).toBe(a.version);
    await setCustomerRating(asCurrent(sales), a.id, { rating: null, note: "ignored" });
    expect((await getFeedback(asCurrent(sales), a.id)).rating).toBeNull();
    expect((await getAppointmentHistory(asCurrent(sales), a.id)).filter((h) => h.action === "CUSTOMER_RATING")).toHaveLength(2);
    await expect(prisma.$executeRaw`UPDATE appointments SET "customerRating" = 3 WHERE id = ${a.id}`).rejects.toThrow(/appointments_rated_check/);
  });

  it("lets only the head of installations grade finished work", async () => {
    const a = await done(await book({ date: daysAgo(5) }));
    await expect(setQualityGrade(asCurrent(sales), a.id, { grade: 5 })).rejects.toBeInstanceOf(ForbiddenError);
    expect(await setQualityGrade(asCurrent(admin), a.id, { grade: 3 })).toEqual({ grade: 3 });
    expect((await getFeedback(asCurrent(admin), a.id)).grade).toBe(3);
    const pending = await book({ date: addDaysToKey(today, 4) });
    await expect(setQualityGrade(asCurrent(admin), pending.id, { grade: 3 })).rejects.toBeInstanceOf(ValidationError);
  });

  it("records each maintenance reminder call once, on finished installations only", async () => {
    const a = await done(await book({ date: daysAgo(180) }));
    await recordMaintenanceCall(asCurrent(sales), a.id, { milestone: 6, note: "Will book in spring" });
    await expect(recordMaintenanceCall(asCurrent(sales), a.id, { milestone: 6, note: null })).rejects.toBeInstanceOf(ValidationError);
    await expect(recordMaintenanceCall(asCurrent(sales), a.id, { milestone: 9, note: null })).rejects.toBeInstanceOf(ValidationError);
    const maintenance = await done(await book({ date: daysAgo(180), visitType: "MAINTENANCE" }));
    await expect(recordMaintenanceCall(asCurrent(sales), maintenance.id, { milestone: 6, note: null })).rejects.toBeInstanceOf(ValidationError);
    expect((await getFeedback(asCurrent(sales), a.id)).calls).toMatchObject([{ milestone: 6, note: "Will book in spring", calledBy: { id: sales.id } }]);
  });
});

describe("follow-up lists", () => {
  it("lists satisfaction calls, quality reviews and maintenance calls as Aura did, and counts them on the dashboard", async () => {
    const callDue = await done(await book({ date: daysAgo(5) }));
    await done(await book({ date: daysAgo(1) })); // too recent
    await done(await book({ date: daysAgo(20) })); // too old
    const rated = await done(await book({ date: daysAgo(6) }));
    await setCustomerRating(asCurrent(sales), rated.id, { rating: 5, note: null });
    await book({ date: daysAgo(5) }); // never finished

    const withPhoto = await done(await book({ date: daysAgo(7) }));
    await uploadAttachment(asCurrent(tech), withPhoto.id, "AFTER_PHOTO", new Uint8Array([0xff, 0xd8, 0xff, 1]));

    const six = await done(await book({ date: daysAgo(185) }));
    const twelve = await done(await book({ date: daysAgo(360) }));
    await done(await book({ date: daysAgo(185), visitType: "PROGRAMMING" })); // not an installation
    const calledSix = await done(await book({ date: daysAgo(184) }));
    await recordMaintenanceCall(asCurrent(sales), calledSix.id, { milestone: 6, note: null });

    const satisfaction = await afterSalesList(asCurrent(sales), "satisfaction");
    expect(satisfaction.map((r) => r.id).sort()).toEqual([callDue.id, withPhoto.id].sort());
    expect(satisfaction.every((r) => r.canAct)).toBe(true);
    expect((await afterSalesList(asCurrent(admin), "quality")).map((r) => r.id)).toEqual([withPhoto.id]);
    await expect(afterSalesList(asCurrent(sales), "quality")).rejects.toBeInstanceOf(ForbiddenError);
    await expect(afterSalesList(asCurrent(tech), "satisfaction")).rejects.toBeInstanceOf(ForbiddenError);
    const maintenance = await afterSalesList(asCurrent(sales), "maintenance");
    expect(maintenance.map((r) => [r.id, r.dueMonths])).toEqual([
      [twelve.id, 12],
      [six.id, 6],
    ]);

    await openComplaint(asCurrent(sales), callDue.id, { description: "Noise" });
    const summary = await dashboardSummary(asCurrent(admin));
    expect(summary.afterSales).toMatchObject({ complaints: 1, satisfaction: 2, quality: 1, maintenance: 2, lists: ["satisfaction", "quality", "maintenance"] });
    expect((await dashboardSummary(asCurrent(sales))).afterSales).toMatchObject({ complaints: 1, satisfaction: 2, quality: 0, maintenance: 2, lists: ["satisfaction", "maintenance"] });
    expect((await dashboardSummary(asCurrent(tech))).afterSales).toBeNull();
  });
});
