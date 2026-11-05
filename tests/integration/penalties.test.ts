import { beforeEach, describe, expect, it } from "vitest";
import type { User } from "@prisma/client";
import { createAppointment } from "@/server/services/appointments";
import { clock, reviewCheckIn } from "@/server/services/attendance";
import { financeStatement } from "@/server/services/payments";
import {
  cancelViolation,
  decideViolation,
  deductionsForMonth,
  getViolation,
  listPenaltyRules,
  listViolations,
  recordViolation,
  savePenaltyRule,
  scanViolations,
} from "@/server/services/penalties";
import { DEFAULT_SETTINGS, updateSettings } from "@/server/services/settings";
import { ForbiddenError, NotFoundError, ValidationError } from "@/server/errors";
import { DEFAULT_TIMEZONE } from "@/lib/constants";
import { zonedToUtc } from "@/lib/time";
import { appointmentPayload, asCurrent, makeUser, prisma, resetDb, seedStatuses } from "../helpers";

/**
 * Violations, warnings and deductions: rules propose, a person approves; only approved deductions
 * reach finance, and a cancellation reverses them. Days in March 2031 (working days, the company
 * starts at 10:00 with 15 minutes of grace); "now" is the morning after.
 */
const tz = DEFAULT_TIMEZONE;
const at = (day: string, time: string) => zonedToUtc(day, time, tz);
const D1 = "2031-03-03";
const D2 = "2031-03-04";
const D3 = "2031-03-05";
const NOW = at("2031-03-06", "09:00");
const COMPANY = { lat: 30.0444, lng: 31.2357 };
const SELFIE = `data:image/jpeg;base64,${Buffer.from([0xff, 0xd8, 0xff, 0xe0, ...Array.from({ length: 64 }, (_, i) => i)]).toString("base64")}`;

let admin: User, admin2: User, accountant: User, tech: User, otherTech: User, sales: User;
const t = (u: User) => asCurrent(u);

beforeEach(async () => {
  await resetDb();
  await seedStatuses();
  admin = await makeUser("ADMIN", { name: "Adel Admin" });
  admin2 = await makeUser("ADMIN", { name: "Basma Admin" });
  accountant = await makeUser("ACCOUNTANT");
  tech = await makeUser("TECHNICIAN", { name: "Aaron Tech" });
  otherTech = await makeUser("TECHNICIAN", { name: "Bea Tech" });
  sales = await makeUser("SALES");
  await updateSettings(t(admin), { ...DEFAULT_SETTINGS, companyLatitude: COMPANY.lat, companyLongitude: COMPANY.lng });
});

const clockIn = (u: User, day: string, time: string) => clock(t(u), { action: "IN", site: "COMPANY", selfie: SELFIE, geo: { ...COMPANY, acc: 10 } }, at(day, time));
const clockOut = (u: User, day: string, time: string) => clock(t(u), { action: "OUT", site: "COMPANY", selfie: SELFIE, geo: { ...COMPANY, acc: 10 } }, at(day, time));

const LATE = { name: "Late arrival", nameAr: "تأخير", trigger: "LATE_ARRIVAL", action: "PER_MINUTE", amount: "2", graceMinutes: 10, maxAmount: "100", warningsFirst: 1 };

/** Aaron arrives 40, 30 and 90 minutes late and clocks out on time. */
async function lateWeek() {
  await clockIn(tech, D1, "10:40");
  await clockOut(tech, D1, "19:05");
  await clockIn(tech, D2, "10:30");
  await clockOut(tech, D2, "19:05");
  await clockIn(tech, D3, "11:30");
  await clockOut(tech, D3, "19:05");
  // Bea is on time every day.
  for (const d of [D1, D2, D3]) {
    await clockIn(otherTech, d, "09:55");
    await clockOut(otherTech, d, "19:10");
  }
}

async function byDay() {
  const rows = await prisma.violation.findMany({ orderBy: { occurredOn: "asc" } });
  return Object.fromEntries(rows.map((r) => [r.occurredOn.toISOString().slice(0, 10), r]));
}

describe("penalty rules", () => {
  it("are set by those who manage penalties, checked, and audited", async () => {
    await expect(savePenaltyRule(t(accountant), null, LATE)).rejects.toBeInstanceOf(ForbiddenError);
    await expect(savePenaltyRule(t(tech), null, LATE)).rejects.toBeInstanceOf(ForbiddenError);
    await expect(listPenaltyRules(t(tech))).rejects.toBeInstanceOf(NotFoundError);
    await expect(savePenaltyRule(t(admin), null, { ...LATE, amount: "0" })).rejects.toMatchObject({ fieldErrors: { amount: "Enter an amount above zero." } });
    await expect(savePenaltyRule(t(admin), null, { ...LATE, trigger: "ABSENCE" })).rejects.toMatchObject({ fieldErrors: { action: expect.stringContaining("per-minute") } });
    await expect(savePenaltyRule(t(admin), null, { ...LATE, graceMinutes: "2.5" })).rejects.toBeInstanceOf(ValidationError);

    const r = await savePenaltyRule(t(admin), null, LATE);
    expect(r).toMatchObject({ trigger: "LATE_ARRIVAL", action: "PER_MINUTE", amount: 2, graceMinutes: 10, maxAmount: 100, warningsFirst: 1, isActive: true });
    // A warning costs nothing, whatever was typed.
    const w = await savePenaltyRule(t(admin), null, { name: "No clock-out", trigger: "MISSING_CLOCK_OUT", action: "WARNING", amount: "50", maxAmount: "10" });
    expect(w).toMatchObject({ amount: 0, maxAmount: null });
    const changed = await savePenaltyRule(t(admin), r.id, { ...LATE, amount: "3" });
    expect(changed.amount).toBe(3);
    expect((await listPenaltyRules(t(accountant))).map((x) => x.name).sort()).toEqual(["Late arrival", "No clock-out"]);
    expect(await prisma.auditLog.count({ where: { entityType: "PENALTY", action: { in: ["PENALTY_RULE_CREATED", "PENALTY_RULE_UPDATED"] } } })).toBe(3);
  });
});

describe("finding violations", () => {
  it("proposes what the rules describe, once, and deducts nothing", async () => {
    await savePenaltyRule(t(admin), null, LATE);
    await lateWeek();
    await expect(scanViolations(t(accountant), { from: D1, to: D3 }, NOW)).rejects.toBeInstanceOf(ForbiddenError);

    const r = await scanViolations(t(admin), { from: D1, to: D3 }, NOW);
    expect(r).toMatchObject({ created: 3, byTrigger: { LATE_ARRIVAL: 3 } });
    const v = await byDay();
    // First one in the month: a warning. Then 2 EGP a minute after 10 minutes of grace, at most 100.
    expect(v[D1]).toMatchObject({ kind: "WARNING", amount: expect.anything(), minutes: 30, status: "PROPOSED", userId: tech.id });
    expect(Number(v[D1].amount)).toBe(0);
    expect(v[D2]).toMatchObject({ kind: "DEDUCTION", minutes: 20, status: "PROPOSED" });
    expect(Number(v[D2].amount)).toBe(40);
    expect(Number(v[D3].amount)).toBe(100);
    expect(v[D2].number).toMatch(/^VIO-2031-\d{6}$/);
    // Bea was on time; nothing for her.
    expect(await prisma.violation.count({ where: { userId: otherTech.id } })).toBe(0);

    // Running it again proposes nothing new; nothing reached finance.
    expect((await scanViolations(t(admin), { from: D1, to: D3 }, NOW)).created).toBe(0);
    expect(await prisma.deductionEntry.count()).toBe(0);
    expect(await deductionsForMonth("2031-03")).toEqual({ people: [], total: 0 });
    // The approvers hear about it (the other Admin; not the one who ran it).
    expect(await prisma.notification.count({ where: { userId: admin2.id, type: "PENALTY" } })).toBe(1);
  });

  it("never proposes the same case twice when two scans run together", async () => {
    await savePenaltyRule(t(admin), null, LATE);
    await lateWeek();
    const [a, b] = await Promise.all([scanViolations(t(admin), { from: D1, to: D3 }, NOW), scanViolations(t(admin2), { from: D1, to: D3 }, NOW)]);
    expect(a.created + b.created).toBe(3);
    expect(await prisma.violation.count()).toBe(3);
  });

  it("finds missing clock-outs, absences, rejected attendance and work sent back", async () => {
    await savePenaltyRule(t(admin), null, { name: "No clock-out", trigger: "MISSING_CLOCK_OUT", action: "WARNING" });
    await savePenaltyRule(t(admin), null, { name: "Absent", trigger: "ABSENCE", action: "FIXED", amount: "200" });
    await savePenaltyRule(t(admin), null, { name: "Bad attendance", trigger: "ATTENDANCE_REJECTED", action: "FIXED", amount: "25" });
    await savePenaltyRule(t(admin), null, { name: "Work redo", trigger: "WORK_REJECTED", action: "FIXED", amount: "75" });
    // Aaron: no clock-out on D1, rejected attendance on D2. Bea: only D3, so absent D1 and D2.
    await clockIn(tech, D1, "09:50");
    const d2 = await clockIn(tech, D2, "09:50");
    await clockOut(tech, D2, "19:00");
    await reviewCheckIn(t(admin), d2.id, { decision: "REJECTED", note: "Photo is of the ceiling" });
    await clockIn(tech, D3, "09:50");
    await clockOut(tech, D3, "19:00");
    await clockIn(otherTech, D3, "09:50");
    await clockOut(otherTech, D3, "19:00");
    // Aaron's work on a visit was sent back on D3.
    const visit = await createAppointment(t(sales), appointmentPayload({ technicianIds: [tech.id], date: "2031-03-10" }));
    await prisma.workReview.create({ data: { appointmentId: visit.id, event: "SUBMITTED", actorId: tech.id, createdAt: at(D3, "12:00") } });
    await prisma.workReview.create({ data: { appointmentId: visit.id, event: "REJECTED", note: "Cables loose", actorId: admin.id, createdAt: at(D3, "13:00") } });

    const r = await scanViolations(t(admin), { from: D1, to: D3 }, NOW);
    expect(r.byTrigger).toEqual({ MISSING_CLOCK_OUT: 1, ABSENCE: 2, ATTENDANCE_REJECTED: 1, WORK_REJECTED: 1 });
    const rows = await prisma.violation.findMany({ include: { user: { select: { name: true } } }, orderBy: [{ trigger: "asc" }, { occurredOn: "asc" }] });
    expect(rows.map((x) => [x.trigger, x.user.name, x.occurredOn.toISOString().slice(0, 10), x.kind, Number(x.amount)])).toEqual([
      ["MISSING_CLOCK_OUT", "Aaron Tech", D1, "WARNING", 0],
      ["ABSENCE", "Bea Tech", D1, "DEDUCTION", 200],
      ["ABSENCE", "Bea Tech", D2, "DEDUCTION", 200],
      ["ATTENDANCE_REJECTED", "Aaron Tech", D2, "DEDUCTION", 25],
      ["WORK_REJECTED", "Aaron Tech", D3, "DEDUCTION", 75],
    ]);
    expect(rows.find((x) => x.trigger === "WORK_REJECTED")?.appointmentId).toBe(visit.id);
  });

  it("does not propose a day whose attendance a manager accepted", async () => {
    await savePenaltyRule(t(admin), null, { name: "No clock-out", trigger: "MISSING_CLOCK_OUT", action: "WARNING" });
    const d1 = await clockIn(tech, D1, "09:50");
    await reviewCheckIn(t(admin), d1.id, { decision: "ACCEPTED", note: "Phone died; left at 19:00" });
    await clockIn(otherTech, D1, "09:50");
    const r = await scanViolations(t(admin), { from: D1, to: D1 }, NOW);
    expect(r.created).toBe(1);
    expect((await prisma.violation.findFirstOrThrow()).userId).toBe(otherTech.id);
  });

  it("refuses periods that are reversed or too long", async () => {
    await expect(scanViolations(t(admin), { from: D3, to: D1 }, NOW)).rejects.toMatchObject({ fieldErrors: { to: "The end is before the start." } });
    await expect(scanViolations(t(admin), { from: "2031-01-01", to: D3 }, NOW)).rejects.toMatchObject({ fieldErrors: { from: "At most 62 days at a time." } });
  });
});

describe("deciding", () => {
  async function proposed() {
    await savePenaltyRule(t(admin), null, LATE);
    await lateWeek();
    await scanViolations(t(admin), { from: D1, to: D3 }, NOW);
    return byDay();
  }

  it("only approvers decide, never on their own violation; only approved deductions reach finance", async () => {
    const v = await proposed();
    await expect(decideViolation(t(tech), v[D2].id, { decision: "APPROVED" })).rejects.toBeInstanceOf(ForbiddenError);
    await expect(decideViolation(t(accountant), v[D2].id, { decision: "APPROVED" })).rejects.toBeInstanceOf(ForbiddenError);
    await expect(decideViolation(t(admin), v[D1].id, { decision: "REJECTED", note: " " })).rejects.toMatchObject({ fieldErrors: { note: "Say why it is rejected." } });

    await decideViolation(t(admin), v[D1].id, { decision: "REJECTED", note: "Traffic accident on the ring road" });
    await decideViolation(t(admin), v[D2].id, { decision: "APPROVED" });
    // The approver may lower the amount; what was proposed is kept.
    await decideViolation(t(admin), v[D3].id, { decision: "APPROVED", amount: "80", note: "First time this month over an hour" });
    await expect(decideViolation(t(admin), v[D2].id, { decision: "REJECTED", note: "changed my mind" })).rejects.toMatchObject({ rawFieldErrors: { _form: "penalties.errors.notProposed" } });

    const d3 = await prisma.violation.findUniqueOrThrow({ where: { id: v[D3].id } });
    expect([d3.status, Number(d3.amount), Number(d3.proposedAmount), d3.decidedById]).toEqual(["APPROVED", 80, 100, admin.id]);
    expect((await deductionsForMonth("2031-03")).people).toEqual([{ userId: tech.id, name: "Aaron Tech", amount: 120, count: 2 }]);
    const fin = await financeStatement(t(accountant), "2031-03");
    expect(fin.deductions.total).toBe(120);
    expect(await prisma.deductionEntry.count({ where: { violationId: v[D1].id } })).toBe(0);
    // The employee is told about each approved deduction.
    expect(await prisma.notification.count({ where: { userId: tech.id, type: "PENALTY" } })).toBe(2);
    expect(await prisma.auditLog.count({ where: { entityType: "PENALTY", action: { in: ["VIOLATION_APPROVED", "VIOLATION_REJECTED"] } } })).toBe(3);

    // A violation recorded for an Admin is decided by another Admin.
    const own = await recordViolation(t(admin2), { userId: admin.id, occurredOn: D1, kind: "WARNING", description: "Left the store open" }, NOW);
    await expect(decideViolation(t(admin), own.id, { decision: "REJECTED", note: "not me" })).rejects.toBeInstanceOf(ForbiddenError);
    await decideViolation(t(admin2), own.id, { decision: "APPROVED" });
  });

  it("may approve a proposed deduction as a warning", async () => {
    const v = await proposed();
    const r = await decideViolation(t(admin), v[D2].id, { decision: "APPROVED", kind: "WARNING", note: "New employee" });
    expect(r).toMatchObject({ kind: "WARNING", amount: 0 });
    expect(await prisma.deductionEntry.count()).toBe(0);
    await expect(decideViolation(t(admin), v[D3].id, { decision: "APPROVED", kind: "DEDUCTION", amount: "0" })).rejects.toBeInstanceOf(ValidationError);
  });

  it("cancels with the reason; an approved deduction is reversed in finance and the record stays", async () => {
    const v = await proposed();
    await decideViolation(t(admin), v[D2].id, { decision: "APPROVED" });
    await decideViolation(t(admin), v[D3].id, { decision: "APPROVED" });
    await expect(cancelViolation(t(accountant), v[D3].id, { reason: "x" })).rejects.toBeInstanceOf(ForbiddenError);
    await expect(cancelViolation(t(admin), v[D3].id, { reason: "" })).rejects.toMatchObject({ fieldErrors: { reason: "Say why it is cancelled." } });

    await cancelViolation(t(admin), v[D3].id, { reason: "The clock-in photo shows he was there at 10:05" });
    await cancelViolation(t(admin), v[D1].id, { reason: "Duplicate of a manual warning" }); // a proposed one
    await expect(cancelViolation(t(admin), v[D3].id, { reason: "again" })).rejects.toMatchObject({ rawFieldErrors: { _form: "penalties.errors.notCancellable" } });

    const entries = await prisma.deductionEntry.findMany({ where: { violationId: v[D3].id }, orderBy: { createdAt: "asc" } });
    expect(entries.map((e) => [e.kind, Number(e.amount), e.month])).toEqual([
      ["APPROVAL", 100, "2031-03"],
      ["REVERSAL", -100, "2031-03"],
    ]);
    expect((await deductionsForMonth("2031-03")).total).toBe(40);
    const detail = await getViolation(t(admin), v[D3].id);
    expect(detail).toMatchObject({ status: "CANCELLED", amount: 100, decidedBy: "Adel Admin", cancelReason: "The clock-in photo shows he was there at 10:05" });
    expect(detail.events.map((e) => e.event)).toEqual(["PROPOSED", "APPROVED", "CANCELLED"]);
    // Only the employee whose approved deduction was cancelled is told.
    const cancelledNote = await prisma.notification.findFirst({ where: { userId: tech.id, message: { contains: "cancelled" } } });
    expect(cancelledNote).not.toBeNull();
  });

  it("shows employees only their own decided warnings and deductions", async () => {
    const v = await proposed();
    await decideViolation(t(admin), v[D1].id, { decision: "REJECTED", note: "Traffic" });
    await decideViolation(t(admin), v[D2].id, { decision: "APPROVED" });
    await decideViolation(t(admin), v[D3].id, { decision: "APPROVED" });
    await cancelViolation(t(admin), v[D3].id, { reason: "Wrong day" });

    const mine = await listViolations(t(tech));
    expect(mine.rows.map((r) => [r.occurredOn, r.status])).toEqual([
      [D3, "CANCELLED"],
      [D2, "APPROVED"],
    ]);
    expect(mine.rows.every((r) => !r.can.decide && !r.can.cancel)).toBe(true);
    await expect(getViolation(t(tech), v[D1].id)).rejects.toBeInstanceOf(NotFoundError);
    expect((await listViolations(t(otherTech))).rows).toEqual([]);
    await expect(getViolation(t(otherTech), v[D2].id)).rejects.toBeInstanceOf(NotFoundError);
    // Finance and Admins see everything, with the month's summary.
    const all = await listViolations(t(accountant), { month: "2031-03" });
    expect(all.total).toBe(3);
    expect(all.summary).toEqual({ proposed: 0, approvedWarnings: 0, approvedDeductions: 1, approvedAmount: 40 });
    expect(all.rows.every((r) => !r.can.decide && !r.can.cancel)).toBe(true);
    expect((await listViolations(t(admin), { status: "REJECTED" })).rows.map((r) => r.id)).toEqual([v[D1].id]);
  });
});

describe("recording by hand", () => {
  it("proposes a violation for an active employee, never for a future day", async () => {
    await expect(recordViolation(t(accountant), { userId: tech.id, occurredOn: D1, kind: "WARNING", description: "x" })).rejects.toBeInstanceOf(ForbiddenError);
    await expect(recordViolation(t(admin), { userId: tech.id, occurredOn: "2031-03-07", kind: "WARNING", description: "x" }, NOW)).rejects.toMatchObject({ fieldErrors: { occurredOn: "The date is in the future." } });
    await expect(recordViolation(t(admin), { userId: tech.id, occurredOn: D1, kind: "DEDUCTION", amount: "", description: "x" }, NOW)).rejects.toMatchObject({ fieldErrors: { amount: "Enter an amount above zero." } });
    const gone = await makeUser("TECHNICIAN", { isActive: false });
    await expect(recordViolation(t(admin), { userId: gone.id, occurredOn: D1, kind: "WARNING", description: "x" }, NOW)).rejects.toMatchObject({ fieldErrors: { userId: "Choose an active employee." } });

    const r = await recordViolation(t(admin), { userId: tech.id, occurredOn: D1, kind: "DEDUCTION", amount: "150", description: "Lost the company drill" }, NOW);
    const v = await prisma.violation.findUniqueOrThrow({ where: { id: r.id } });
    expect([v.trigger, v.status, Number(v.amount), v.createdById]).toEqual(["MANUAL", "PROPOSED", 150, admin.id]);
    expect(await prisma.deductionEntry.count()).toBe(0);
  });
});

describe("database guards", () => {
  it("keep decided violations, their history and the finance entries unchanged", async () => {
    await savePenaltyRule(t(admin), null, LATE);
    await lateWeek();
    await scanViolations(t(admin), { from: D1, to: D3 }, NOW);
    const v = await byDay();
    await decideViolation(t(admin), v[D2].id, { decision: "APPROVED" });

    await expect(prisma.violation.update({ where: { id: v[D2].id }, data: { amount: 1 } })).rejects.toThrow(/approved violation cannot be changed/);
    await expect(prisma.violation.update({ where: { id: v[D2].id }, data: { status: "PROPOSED", decidedById: null, decidedAt: null } })).rejects.toThrow();
    await expect(prisma.violation.delete({ where: { id: v[D1].id } })).rejects.toThrow(/never deleted/);
    await expect(prisma.violation.update({ where: { id: v[D1].id }, data: { userId: otherTech.id } })).rejects.toThrow(/record cannot be changed/);
    // Approving needs who decided; a rejection needs its reason.
    await expect(prisma.violation.update({ where: { id: v[D1].id }, data: { status: "APPROVED" } })).rejects.toThrow(/violations_status_check/);
    await expect(prisma.violation.update({ where: { id: v[D1].id }, data: { status: "REJECTED", decidedById: admin.id, decidedAt: new Date() } })).rejects.toThrow(/violations_status_check/);
    // A deduction entry only for an approved deduction, with its amount.
    await expect(prisma.deductionEntry.create({ data: { violationId: v[D3].id, userId: tech.id, month: "2031-03", amount: 100, kind: "APPROVAL", createdById: admin.id } })).rejects.toThrow(/only an approved deduction/);
    const entry = await prisma.deductionEntry.findFirstOrThrow();
    await expect(prisma.deductionEntry.update({ where: { id: entry.id }, data: { amount: 1 } })).rejects.toThrow(/append-only/);
    await expect(prisma.deductionEntry.delete({ where: { id: entry.id } })).rejects.toThrow(/append-only/);
    const ev = await prisma.violationEvent.findFirstOrThrow();
    await expect(prisma.violationEvent.delete({ where: { id: ev.id } })).rejects.toThrow(/append-only/);
  });
});
