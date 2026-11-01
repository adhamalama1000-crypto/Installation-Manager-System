import { beforeEach, describe, expect, it } from "vitest";
import type { User } from "@prisma/client";
import { createAppointment } from "@/server/services/appointments";
import { dashboardSummary } from "@/server/services/dashboard";
import { dayPlan } from "@/server/services/day-plan";
import { reportCsv } from "@/server/services/reports";
import { DEFAULT_TIMEZONE } from "@/lib/constants";
import { addDaysToKey, todayKey } from "@/lib/time";
import { appointmentPayload, asCurrent, makeUser, resetDb, seedStatuses } from "../helpers";

/**
 * Follow-ups to the booking helpers (#9): the dashboard warns about smart-home sites that are not
 * confirmed ready, and the day plan tells the technician to pick up a lock kept at the company.
 */
const tz = DEFAULT_TIMEZONE;
// Three days ahead: inside the dashboard's coming week, past its "confirm by tomorrow" reminder.
const day = addDaysToKey(todayKey(tz), 3);

let admin: User, sales: User, tech: User, otherTech: User, viewer: User;
beforeEach(async () => {
  await resetDb();
  await seedStatuses();
  admin = await makeUser("ADMIN");
  sales = await makeUser("SALES");
  tech = await makeUser("TECHNICIAN", { name: "Karim Tech" });
  otherTech = await makeUser("TECHNICIAN", { name: "Hany Tech" });
  // Sees appointments but not addresses, so the "no map location" check does not apply to them.
  viewer = await makeUser("VIEWER", { viewerPermissions: ["appointments.view"] });
});

const smartHome = (o: Record<string, unknown>) =>
  createAppointment(asCurrent(sales), appointmentPayload({ date: day, durationMinutes: 60, productCategory: "SMART_HOME", technicianIds: [tech.id], ...o }));

describe("dashboard warning for smart-home sites that are not ready", () => {
  it("flags upcoming smart-home installations whose wiring or internet is not confirmed ready", async () => {
    const internetDown = await smartHome({ startTime: "10:00", siteFoundation: "READY", siteInternet: "NOT_READY" });
    const notChecked = await smartHome({ startTime: "12:00" });
    const ready = await smartHome({ startTime: "14:00", siteFoundation: "READY", siteInternet: "READY" });
    const inspection = await smartHome({ startTime: "16:00", visitType: "INSPECTION" });
    const lock = await createAppointment(asCurrent(sales), appointmentPayload({ date: day, startTime: "18:00", durationMinutes: 60, technicianIds: [tech.id] }));

    const summary = await dashboardSummary(asCurrent(admin));
    const reasons = new Map(summary.attention.map((a) => [a.id, a.reason]));
    expect(reasons.get(internetDown.id)).toBe("dashboard.reasons.siteNotReady");
    expect(reasons.get(notChecked.id)).toBe("dashboard.reasons.siteNotReady");
    for (const a of [ready, inspection, lock]) expect(reasons.has(a.id), a.code).toBe(false);
    expect(summary.siteNotReady).toBe(2);
  });

  it("keeps to what each reader may see", async () => {
    const flagged = await smartHome({ startTime: "10:00", siteFoundation: "NOT_READY" });
    // The assigned technician sees it; another technician does not.
    expect((await dashboardSummary(asCurrent(tech))).attention.map((a) => a.id)).toContain(flagged.id);
    const other = await dashboardSummary(asCurrent(otherTech));
    expect(other.attention.map((a) => a.id)).not.toContain(flagged.id);
    expect(other.siteNotReady).toBe(0);
    // A viewer without location access still gets the readiness warning (the location check is
    // left out for them, not the whole statement).
    const v = await dashboardSummary(asCurrent(viewer));
    expect(v.attention.find((a) => a.id === flagged.id)?.reason).toBe("dashboard.reasons.siteNotReady");
  });

  it("still lists visits without a map location separately", async () => {
    const noPin = await createAppointment(
      asCurrent(sales),
      appointmentPayload({ date: day, startTime: "10:00", durationMinutes: 60, technicianIds: [tech.id], location: { area: "Maadi", mapUrl: "", latitude: "", longitude: "" } }),
    );
    const summary = await dashboardSummary(asCurrent(admin));
    expect(summary.attention.find((a) => a.id === noPin.id)?.reason).toBe("dashboard.reasons.noLocation");
    expect(summary.siteNotReady).toBe(0);
  });
});

describe("lock pickup from the company", () => {
  it("tells the technician in the day plan, in their language, and marks the visit", async () => {
    const fromCompany = await createAppointment(asCurrent(sales), appointmentPayload({ date: day, startTime: "10:00", durationMinutes: 60, technicianIds: [tech.id], lockAt: "COMPANY" }));
    const atCustomer = await createAppointment(asCurrent(sales), appointmentPayload({ date: day, startTime: "13:00", durationMinutes: 60, technicianIds: [tech.id], lockAt: "CUSTOMER" }));

    const en = await dayPlan(asCurrent(sales), day);
    const plan = en.technicians.find((x) => x.id === tech.id)!;
    expect(plan.visits.find((v) => v.id === fromCompany.id)?.lockFromCompany).toBe(true);
    expect(plan.visits.find((v) => v.id === atCustomer.id)?.lockFromCompany).toBe(false);
    expect(plan.message.match(/Pick up the lock from the company before you set off/g)).toHaveLength(1);
    // The line belongs to the visit that needs it, before the next visit starts.
    const [first, second] = plan.message.split(/\n2\) /);
    expect(first).toContain("Pick up the lock from the company");
    expect(second).not.toContain("Pick up the lock");

    const ar = await dayPlan(asCurrent(sales, {}, "ar"), day);
    expect(ar.technicians.find((x) => x.id === tech.id)!.message).toContain("خد اللوك من الشركة قبل ما تتحرك");
  });

  it("appears in the appointment CSV export", async () => {
    await createAppointment(asCurrent(sales), appointmentPayload({ date: day, startTime: "10:00", durationMinutes: 60, lockAt: "COMPANY" }));
    const csv = await reportCsv(asCurrent(admin), "appointments", { from: day, to: day });
    const [header, row] = csv.replace(/^﻿/, "").trim().split("\r\n");
    expect(header!.split(",").at(-1)).toBe("Where the lock is");
    expect(row).toContain("At the company (pick up first)");
    const arCsv = await reportCsv(asCurrent(admin, {}, "ar"), "appointments", { from: day, to: day });
    expect(arCsv).toContain("مكان اللوك");
    expect(arCsv).toContain("في مقر الشركة (يستلمه الأول)");
  });
});
