import { beforeEach, describe, expect, it } from "vitest";
import type { User } from "@prisma/client";
import { cancelAppointment, createAppointment, getAppointment, getAppointmentHistory, recordVisitOutcome } from "@/server/services/appointments";
import { dashboardSummary } from "@/server/services/dashboard";
import { listNotifications } from "@/server/services/notifications";
import { DEFAULT_SETTINGS, updateSettings } from "@/server/services/settings";
import { ForbiddenError, NotFoundError, StaleRecordError, ValidationError } from "@/server/errors";
import { appointmentPayload, asCurrent, makeUser, prisma, resetDb, seedStatuses } from "../helpers";

let statuses: Awaited<ReturnType<typeof seedStatuses>>;
let admin: User, sales: User, otherSales: User, tech: User, otherTech: User, viewer: User;

beforeEach(async () => {
  await resetDb();
  statuses = await seedStatuses();
  admin = await makeUser("ADMIN");
  sales = await makeUser("SALES");
  otherSales = await makeUser("SALES");
  tech = await makeUser("TECHNICIAN");
  otherTech = await makeUser("TECHNICIAN");
  viewer = await makeUser("VIEWER", { viewerPermissions: ["appointments.view"] });
});

async function book(technicianIds: string[] = [tech.id]) {
  return createAppointment(asCurrent(sales), appointmentPayload({ technicianIds }));
}

describe("recording the outcome of a visit", () => {
  it("lets the assigned technician start the job and finish it with a mandatory report", async () => {
    const a = await book();
    expect((await getAppointment(asCurrent(tech), a.id)).canReport).toBe(true);
    const started = await recordVisitOutcome(asCurrent(tech), a.id, { outcome: "IN_PROGRESS", version: a.version });
    expect(started.status.kind).toBe("IN_PROGRESS");
    await expect(recordVisitOutcome(asCurrent(tech), a.id, { outcome: "COMPLETED", version: started.version })).rejects.toBeInstanceOf(ValidationError);
    await expect(recordVisitOutcome(asCurrent(tech), a.id, { outcome: "COMPLETED", report: "   ", version: started.version })).rejects.toBeInstanceOf(ValidationError);
    const done = await recordVisitOutcome(asCurrent(tech), a.id, { outcome: "COMPLETED", report: "Lock installed, app paired, 3 fingerprints added.", version: started.version });
    expect(done.status.kind).toBe("COMPLETED");
    expect(done.visitReport).toBe("Lock installed, app paired, 3 fingerprints added.");
    expect(done.reportedBy?.id).toBe(tech.id);
    expect(done.reportedAt).toBeTruthy();

    const history = await getAppointmentHistory(asCurrent(sales), a.id);
    expect(history[0]).toMatchObject({
      action: "VISIT_OUTCOME",
      changes: { status: { from: "In Progress", to: "Completed" }, visitReport: { from: null, to: "Lock installed, app paired, 3 fingerprints added." } },
    });
    // The Sales creator is told; the technician does not notify himself.
    const forSales = await listNotifications(asCurrent(sales));
    expect(forSales.items.some((n) => n.type === "VISIT_OUTCOME" && n.appointmentId === a.id)).toBe(true);
    const forTech = await listNotifications(asCurrent(tech));
    expect(forTech.items.some((n) => n.type === "VISIT_OUTCOME")).toBe(false);
  });

  it("lets a technician correct the outcome and the report", async () => {
    const a = await book([tech.id, otherTech.id]);
    const first = await recordVisitOutcome(asCurrent(tech), a.id, { outcome: "COMPLETED", report: "Done", version: a.version });
    const fixed = await recordVisitOutcome(asCurrent(otherTech), a.id, { outcome: "NEEDS_REVISIT", report: "Cylinder missing, come back with a 70 mm one.", version: first.version });
    expect(fixed.status.kind).toBe("NEEDS_REVISIT");
    expect(fixed.reportedBy?.id).toBe(otherTech.id);
    // The other technician on the job is notified too.
    expect((await listNotifications(asCurrent(tech))).items.some((n) => n.type === "VISIT_OUTCOME")).toBe(true);
  });

  it("refuses technicians who are not assigned, viewers, and Sales without edit rights", async () => {
    const a = await book();
    await expect(recordVisitOutcome(asCurrent(otherTech), a.id, { outcome: "COMPLETED", report: "x" })).rejects.toBeInstanceOf(NotFoundError);
    await expect(recordVisitOutcome(asCurrent(viewer), a.id, { outcome: "COMPLETED", report: "x" })).rejects.toBeInstanceOf(ForbiddenError);
    await updateSettings(asCurrent(admin), { ...DEFAULT_SETTINGS, salesCanEditOthersAppointments: false });
    const restricted = asCurrent(otherSales, { salesCanEditOthersAppointments: false });
    await expect(recordVisitOutcome(restricted, a.id, { outcome: "COMPLETED", report: "x" })).rejects.toBeInstanceOf(ForbiddenError);
    // The creator (a manager of the booking) may record it.
    const bySales = await recordVisitOutcome(asCurrent(sales, { salesCanEditOthersAppointments: false }), a.id, { outcome: "UNABLE_TO_COMPLETE", report: "Customer not home." });
    expect(bySales.status.kind).toBe("UNABLE_TO_COMPLETE");
  });

  it("rejects stale versions and cancelled appointments", async () => {
    const a = await book();
    await recordVisitOutcome(asCurrent(tech), a.id, { outcome: "IN_PROGRESS", version: a.version });
    await expect(recordVisitOutcome(asCurrent(tech), a.id, { outcome: "COMPLETED", report: "Done", version: a.version })).rejects.toBeInstanceOf(StaleRecordError);
    const b = await createAppointment(asCurrent(sales), appointmentPayload({ technicianIds: [tech.id], date: "2030-03-11" }));
    await cancelAppointment(asCurrent(sales), b.id, {});
    await expect(recordVisitOutcome(asCurrent(tech), b.id, { outcome: "COMPLETED", report: "Done" })).rejects.toBeInstanceOf(ValidationError);
  });

  it("explains when no status of that kind is set up", async () => {
    const a = await book();
    await prisma.appointmentStatus.update({ where: { id: statuses.NEEDS_REVISIT }, data: { isActive: false } });
    await expect(recordVisitOutcome(asCurrent(tech), a.id, { outcome: "NEEDS_REVISIT", report: "x" })).rejects.toThrow(/No active "Needs another visit" status/);
  });

  it("asks for a follow-up on the dashboard until one is booked", async () => {
    const a = await book();
    await recordVisitOutcome(asCurrent(tech), a.id, { outcome: "NEEDS_REVISIT", report: "Needs a longer cable." });
    const now = new Date("2030-03-12T10:00:00Z");
    const before = await dashboardSummary(asCurrent(sales), now);
    expect(before.attention).toContainEqual(expect.objectContaining({ id: a.id, reason: "Needs another visit - no follow-up booked" }));
    await createAppointment(asCurrent(sales), appointmentPayload({ followUpOfId: a.id, date: "2030-03-14", technicianIds: [tech.id] }));
    const after = await dashboardSummary(asCurrent(sales), now);
    expect(after.attention.map((x) => x.id)).not.toContain(a.id);
  });
});
