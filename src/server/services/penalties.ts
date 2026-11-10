import "server-only";
import { Prisma, type PenaltyRule, type PenaltyTrigger, type ViolationKind, type ViolationStatus } from "@prisma/client";
import { msg } from "@/i18n/translator";
import { appointmentCode } from "@/lib/constants";
import { formatDocNumber } from "@/lib/inventory";
import { cancelViolationSchema, manualViolationSchema, penaltyFor, penaltyRuleSchema, scanSchema, violationDecisionSchema, type PenaltyTriggerValue } from "@/lib/penalties";
import { addDaysToKey, dateKey, todayKey } from "@/lib/time";
import { prisma, type Tx } from "../db";
import { assertCan, hasPermission } from "../access";
import type { CurrentUser } from "../auth/session";
import { ForbiddenError, NotFoundError } from "../errors";
import { attendanceRange } from "./attendance";
import { recordAudit } from "./audit";
import { checkId, dbDate, formError, keyOf, nextSequence, pageOf, parseInput } from "./inventory-common";
import { notifyUsers } from "./notifications";

/**
 * Violations, warnings and deductions (Aura: المخالفات والجزاءات). Rules only propose: a scan of
 * attendance and work reviews, or a person, records a PROPOSED violation; someone with
 * `penalties.approve` approves it (possibly as a warning or with another amount) or rejects it with
 * the reason. Only an approved deduction reaches finance, as an append-only deduction entry; a
 * cancellation (with its reason) adds a reversing entry. Nothing is ever edited or deleted once
 * decided (database guards in the migration).
 */

const D = (v: Prisma.Decimal | number | null | undefined) => (v === null || v === undefined ? 0 : Number(v));
const PAGE_SIZE = 50;
const PREFIX = "VIO";

function canSeeAll(user: CurrentUser) {
  return hasPermission(user, "penalties.view") || hasPermission(user, "penalties.manage") || hasPermission(user, "penalties.approve");
}

// ---------------------------------------------------------------------------------------------
// Rules
// ---------------------------------------------------------------------------------------------

export type PenaltyRuleDTO = {
  id: string;
  name: string;
  nameAr: string | null;
  trigger: PenaltyTrigger;
  action: PenaltyRule["action"];
  amount: number;
  graceMinutes: number;
  maxAmount: number | null;
  warningsFirst: number;
  description: string | null;
  isActive: boolean;
};

function ruleDTO(r: PenaltyRule): PenaltyRuleDTO {
  return { id: r.id, name: r.name, nameAr: r.nameAr, trigger: r.trigger, action: r.action, amount: D(r.amount), graceMinutes: r.graceMinutes, maxAmount: r.maxAmount === null ? null : D(r.maxAmount), warningsFirst: r.warningsFirst, description: r.description, isActive: r.isActive };
}

export async function listPenaltyRules(user: CurrentUser, opts: { activeOnly?: boolean } = {}): Promise<PenaltyRuleDTO[]> {
  if (!canSeeAll(user)) throw new NotFoundError();
  const rows = await prisma.penaltyRule.findMany({ where: opts.activeOnly ? { isActive: true } : {}, orderBy: [{ isActive: "desc" }, { trigger: "asc" }, { name: "asc" }] });
  return rows.map(ruleDTO);
}

/** Creates (id null) or changes a rule. Violations already proposed keep what they were proposed as. */
export async function savePenaltyRule(user: CurrentUser, id: string | null, raw: unknown): Promise<PenaltyRuleDTO> {
  assertCan(user, "penalties.manage");
  const v = parseInput(penaltyRuleSchema, raw);
  return prisma.$transaction(async (tx) => {
    const before = id ? await tx.penaltyRule.findUnique({ where: { id: checkId(id) } }) : null;
    if (id && !before) throw new NotFoundError();
    const data = { ...v, amount: new Prisma.Decimal(v.amount), maxAmount: v.maxAmount === null ? null : new Prisma.Decimal(v.maxAmount), updatedById: user.id };
    const r = before ? await tx.penaltyRule.update({ where: { id: before.id }, data }) : await tx.penaltyRule.create({ data });
    await recordAudit(tx, {
      entityType: "PENALTY",
      entityId: r.id,
      action: before ? "PENALTY_RULE_UPDATED" : "PENALTY_RULE_CREATED",
      summary: msg(before ? "erpAudit.penaltyRuleUpdated" : "erpAudit.penaltyRuleCreated", { name: user.name, rule: r.name, ruleAr: r.nameAr ?? "" }),
      changes: { before: before ? ruleDTO(before) : null, after: ruleDTO(r) },
      actorId: user.id,
    });
    return ruleDTO(r);
  });
}

// ---------------------------------------------------------------------------------------------
// Proposing violations
// ---------------------------------------------------------------------------------------------

type Proposal = {
  userId: string;
  rule: PenaltyRule | null;
  trigger: PenaltyTrigger;
  sourceKey: string | null;
  occurredOn: string;
  minutes: number | null;
  kind: ViolationKind;
  amount: number;
  description: string;
  appointmentId: string | null;
};

async function approvers(tx: Tx, except: string): Promise<string[]> {
  // penalties.approve: the Admins.
  const rows = await tx.user.findMany({ where: { isActive: true, role: "ADMIN", id: { not: except } }, select: { id: true } });
  return rows.map((r) => r.id);
}

async function insertProposal(tx: Tx, user: CurrentUser, p: Proposal) {
  const year = Number(p.occurredOn.slice(0, 4));
  const number = formatDocNumber(PREFIX, year, await nextSequence(tx, `${PREFIX}-${year}`));
  const v = await tx.violation.create({
    data: {
      number,
      userId: p.userId,
      ruleId: p.rule?.id ?? null,
      trigger: p.trigger,
      sourceKey: p.sourceKey,
      occurredOn: dbDate(p.occurredOn),
      minutes: p.minutes,
      kind: p.kind,
      amount: new Prisma.Decimal(p.amount),
      proposedKind: p.kind,
      proposedAmount: new Prisma.Decimal(p.amount),
      description: p.description,
      appointmentId: p.appointmentId,
      createdById: user.id,
    },
  });
  await tx.violationEvent.create({ data: { violationId: v.id, event: "PROPOSED", kind: p.kind, amount: new Prisma.Decimal(p.amount), note: null, actorId: user.id, createdAt: new Date() } });
  return v;
}

/** Records a violation by hand. It is only proposed: someone with the approval right decides. */
export async function recordViolation(user: CurrentUser, raw: unknown, now = new Date()) {
  assertCan(user, "penalties.manage");
  const v = parseInput(manualViolationSchema, raw);
  const tz = user.settings.timezone;
  if (v.occurredOn > todayKey(tz, now)) throw formError("penalties.errors.future", undefined, "occurredOn");
  return prisma.$transaction(async (tx) => {
    const employee = await tx.user.findFirst({ where: { id: v.userId, isActive: true }, select: { id: true, name: true } });
    if (!employee) throw formError("penalties.errors.employee", undefined, "userId");
    const rule = v.ruleId ? await tx.penaltyRule.findFirst({ where: { id: v.ruleId, isActive: true } }) : null;
    if (v.ruleId && !rule) throw formError("penalties.errors.rule", undefined, "ruleId");
    if (v.appointmentId && !(await tx.appointment.findUnique({ where: { id: v.appointmentId }, select: { id: true } }))) throw formError("errors.appointmentNotFound", undefined, "appointmentId");
    const row = await insertProposal(tx, user, {
      userId: employee.id,
      rule,
      trigger: "MANUAL",
      sourceKey: null,
      occurredOn: v.occurredOn,
      minutes: null,
      kind: v.kind,
      amount: v.amount,
      description: v.description,
      appointmentId: v.appointmentId ?? null,
    });
    await recordAudit(tx, {
      entityType: "PENALTY",
      entityId: row.id,
      action: "VIOLATION_PROPOSED",
      summary: msg("erpAudit.violationProposed", { name: user.name, number: row.number, person: employee.name }),
      changes: { userId: employee.id, kind: v.kind, amount: v.amount, occurredOn: v.occurredOn, description: v.description },
      actorId: user.id,
    });
    await notifyUsers(tx, await approvers(tx, user.id), { type: "PENALTY", message: msg("penalties.notify.proposed", { count: 1 }) }, user.id);
    return { id: row.id, number: row.number };
  });
}

type Occurrence = { userId: string; occurredOn: string; minutes: number | null; source: string; appointmentId: string | null; detail: string };

const ATTENDANCE_TRIGGERS: PenaltyTriggerValue[] = ["LATE_ARRIVAL", "EARLY_LEAVE", "MISSING_CLOCK_OUT", "ABSENCE"];

/** What happened in the period, for each trigger the active rules use. */
async function occurrences(user: CurrentUser, triggers: Set<PenaltyTrigger>, from: string, to: string, today: string, now: Date): Promise<Map<PenaltyTrigger, Occurrence[]>> {
  const out = new Map<PenaltyTrigger, Occurrence[]>();
  const push = (t: PenaltyTrigger, o: Occurrence) => out.set(t, [...(out.get(t) ?? []), o]);
  const tz = user.settings.timezone;

  // Everyone's attendance needs the attendance right (otherwise the page shows only one's own).
  const seesAttendance = hasPermission(user, "attendance.view") || hasPermission(user, "attendance.manage");
  if (seesAttendance && ATTENDANCE_TRIGGERS.some((t) => triggers.has(t))) {
    // The attendance page's own reading of the days, so both always agree. A day whose
    // attendance a manager already accepted is not proposed again.
    const range = await attendanceRange(user, from, to, {}, now);
    for (const r of range.rows) {
      if (r.review?.decision === "ACCEPTED") continue;
      if (r.clockIn?.lateMinutes) push("LATE_ARRIVAL", { userId: r.person.id, occurredOn: r.day, minutes: r.clockIn.lateMinutes, source: r.clockIn.id, appointmentId: null, detail: msg("penalties.auto.late", { minutes: r.clockIn.lateMinutes }) });
      if (r.clockOut?.earlyMinutes) push("EARLY_LEAVE", { userId: r.person.id, occurredOn: r.day, minutes: r.clockOut.earlyMinutes, source: r.clockOut.id, appointmentId: null, detail: msg("penalties.auto.early", { minutes: r.clockOut.earlyMinutes }) });
      if (r.missingCheckout && r.clockIn && r.day < today) push("MISSING_CLOCK_OUT", { userId: r.person.id, occurredOn: r.day, minutes: null, source: r.clockIn.id, appointmentId: null, detail: msg("penalties.auto.missingOut") });
      if (r.status === "absent" && r.day < today) push("ABSENCE", { userId: r.person.id, occurredOn: r.day, minutes: null, source: `${r.person.id}:${r.day}`, appointmentId: null, detail: msg("penalties.auto.absent") });
    }
  }
  if (triggers.has("ATTENDANCE_REJECTED")) {
    const rows = await prisma.attendanceReview.findMany({
      where: { decision: "REJECTED", checkIn: { day: { gte: dbDate(from), lte: dbDate(to) } } },
      select: { id: true, note: true, checkIn: { select: { userId: true, day: true, kind: true } } },
    });
    for (const r of rows) push("ATTENDANCE_REJECTED", { userId: r.checkIn.userId, occurredOn: keyOf(r.checkIn.day), minutes: null, source: r.id, appointmentId: null, detail: msg("penalties.auto.attendanceRejected", { note: r.note ?? "" }) });
  }
  if (triggers.has("WORK_REJECTED")) {
    const start = new Date(`${addDaysToKey(from, -1)}T00:00:00Z`);
    const end = new Date(`${addDaysToKey(to, 2)}T00:00:00Z`);
    const rows = await prisma.workReview.findMany({
      where: { event: "REJECTED", createdAt: { gte: start, lt: end } },
      select: { id: true, note: true, createdAt: true, appointment: { select: { id: true, number: true, technicians: { select: { technicianId: true } } } } },
    });
    for (const r of rows) {
      const day = dateKey(r.createdAt, tz);
      if (day < from || day > to) continue;
      for (const t of r.appointment.technicians) {
        push("WORK_REJECTED", { userId: t.technicianId, occurredOn: day, minutes: null, source: `${r.id}:${t.technicianId}`, appointmentId: r.appointment.id, detail: msg("penalties.auto.workRejected", { code: appointmentCode(r.appointment.number), note: r.note ?? "" }) });
      }
    }
  }
  return out;
}

/**
 * Looks through attendance and work reviews of a period and proposes the violations the active
 * rules describe. Safe to run again: each source is proposed once per rule (even if it was
 * rejected), and nothing is deducted until someone approves it.
 */
export async function scanViolations(user: CurrentUser, raw: unknown, now = new Date()) {
  assertCan(user, "penalties.manage");
  const v = parseInput(scanSchema, raw);
  const tz = user.settings.timezone;
  const today = todayKey(tz, now);
  const to = v.to > today ? today : v.to;
  const from = v.from > to ? to : v.from;
  const rules = await prisma.penaltyRule.findMany({ where: { isActive: true, trigger: { not: "MANUAL" } } });
  const created: Record<string, number> = {};
  if (!rules.length) return { from, to, created: 0, byTrigger: created };
  const found = await occurrences(user, new Set(rules.map((r) => r.trigger)), from, to, today, now);

  const count = await prisma.$transaction(
    async (tx) => {
      // One scan at a time, so two people scanning together do not both propose.
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended('penalties:scan', 0))`;
      const candidates = rules.flatMap((rule) => (found.get(rule.trigger) ?? []).map((o) => ({ rule, o, key: `${rule.id}:${o.source}` })));
      if (!candidates.length) return 0;
      const existing = new Set(
        (await tx.violation.findMany({ where: { sourceKey: { in: candidates.map((c) => c.key) } }, select: { sourceKey: true } })).map((x) => x.sourceKey),
      );
      // Occurrences of each rule already standing in each month (for "first N are warnings").
      const months = [...new Set(candidates.map((c) => c.o.occurredOn.slice(0, 7)))];
      const standing = await tx.violation.groupBy({
        by: ["ruleId", "userId", "occurredOn"],
        where: {
          ruleId: { in: rules.map((r) => r.id) },
          status: { in: ["PROPOSED", "APPROVED"] },
          occurredOn: { gte: dbDate(`${months.sort()[0]}-01`), lte: dbDate(`${addDaysToKey(`${months[months.length - 1]}-01`, 31)}`) },
        },
        _count: { _all: true },
      });
      const tally = new Map<string, number>();
      for (const s of standing) {
        const k = `${s.ruleId}:${s.userId}:${keyOf(s.occurredOn).slice(0, 7)}`;
        tally.set(k, (tally.get(k) ?? 0) + s._count._all);
      }
      let n = 0;
      const sorted = candidates.filter((c) => !existing.has(c.key)).sort((a, b) => a.o.occurredOn.localeCompare(b.o.occurredOn) || a.key.localeCompare(b.key));
      for (const { rule, o, key } of sorted) {
        const k = `${rule.id}:${o.userId}:${o.occurredOn.slice(0, 7)}`;
        const earlier = tally.get(k) ?? 0;
        const p = penaltyFor({ action: rule.action, amount: D(rule.amount), graceMinutes: rule.graceMinutes, maxAmount: rule.maxAmount === null ? null : D(rule.maxAmount), warningsFirst: rule.warningsFirst }, o.minutes, earlier);
        if (!p) continue;
        await insertProposal(tx, user, { userId: o.userId, rule, trigger: rule.trigger, sourceKey: key, occurredOn: o.occurredOn, minutes: p.minutes, kind: p.kind, amount: p.amount, description: o.detail, appointmentId: o.appointmentId });
        tally.set(k, earlier + 1);
        created[rule.trigger] = (created[rule.trigger] ?? 0) + 1;
        n++;
      }
      if (n) {
        await recordAudit(tx, {
          entityType: "PENALTY",
          entityId: "scan",
          action: "VIOLATIONS_SCANNED",
          summary: msg("erpAudit.violationsScanned", { name: user.name, count: n, from, to }),
          changes: { from, to, created },
          actorId: user.id,
        });
        await notifyUsers(tx, await approvers(tx, user.id), { type: "PENALTY", message: msg("penalties.notify.proposed", { count: n }) }, user.id);
      }
      return n;
    },
    { timeout: 60_000, maxWait: 10_000 },
  );
  return { from, to, created: count, byTrigger: created };
}

// ---------------------------------------------------------------------------------------------
// Decisions
// ---------------------------------------------------------------------------------------------

async function lockViolation(tx: Tx, id: string) {
  await tx.$queryRaw`SELECT id FROM violations WHERE id = ${id} FOR UPDATE`;
  const v = await tx.violation.findUnique({ where: { id }, include: { user: { select: { id: true, name: true } } } });
  if (!v) throw new NotFoundError();
  return v;
}

const monthOf = (d: Date) => keyOf(d).slice(0, 7);

/**
 * Approves a proposed violation (as proposed, or as a warning / with another amount, recorded with
 * the note) or rejects it with the reason. An approved deduction becomes a deduction entry for
 * finance. Nobody decides on their own violation.
 */
export async function decideViolation(user: CurrentUser, id: string, raw: unknown) {
  assertCan(user, "penalties.approve");
  const d = parseInput(violationDecisionSchema, raw);
  return prisma.$transaction(async (tx) => {
    const v = await lockViolation(tx, checkId(id));
    if (v.userId === user.id) throw new ForbiddenError("penalties.errors.own");
    if (v.status !== "PROPOSED") throw formError("penalties.errors.notProposed");
    const now = new Date();
    let kind: ViolationKind = v.kind;
    let amount = D(v.amount);
    if (d.decision === "APPROVED") {
      kind = d.kind ?? v.kind;
      amount = kind === "WARNING" ? 0 : (d.amount ?? (v.kind === "DEDUCTION" ? amount : 0));
      if (kind === "DEDUCTION" && !(amount > 0)) throw formError("penalties.errors.amount", undefined, "amount");
    }
    const status: ViolationStatus = d.decision;
    await tx.violation.update({
      where: { id: v.id },
      data: { status, kind, amount: new Prisma.Decimal(amount), decidedById: user.id, decidedAt: now, decisionNote: d.note },
    });
    await tx.violationEvent.create({ data: { violationId: v.id, event: status, kind, amount: new Prisma.Decimal(amount), note: d.note, actorId: user.id, createdAt: now } });
    if (status === "APPROVED" && kind === "DEDUCTION") {
      await tx.deductionEntry.create({ data: { violationId: v.id, userId: v.userId, month: monthOf(v.occurredOn), amount: new Prisma.Decimal(amount), kind: "APPROVAL", createdById: user.id, createdAt: now } });
    }
    const changed = status === "APPROVED" && (kind !== v.proposedKind || amount !== D(v.proposedAmount));
    await recordAudit(tx, {
      entityType: "PENALTY",
      entityId: v.id,
      action: status === "APPROVED" ? "VIOLATION_APPROVED" : "VIOLATION_REJECTED",
      summary: msg(status === "APPROVED" ? "erpAudit.violationApproved" : "erpAudit.violationRejected", { name: user.name, number: v.number, person: v.user.name, note: d.note ?? "" }),
      changes: { status: { from: "PROPOSED", to: status }, ...(changed ? { kind: { from: v.proposedKind, to: kind }, amount: { from: D(v.proposedAmount), to: amount } } : {}), note: d.note },
      actorId: user.id,
    });
    if (status === "APPROVED") {
      await notifyUsers(
        tx,
        [v.userId],
        { type: "PENALTY", message: kind === "WARNING" ? msg("penalties.notify.warning", { number: v.number }) : msg("penalties.notify.deduction", { number: v.number, amount }) },
        user.id,
      );
    }
    return { id: v.id, status, kind, amount };
  });
}

/**
 * Cancels a violation with the reason: a proposed one (whoever records or approves violations), or
 * an approved one (approvers only), whose deduction is then reversed in finance. The record stays.
 */
export async function cancelViolation(user: CurrentUser, id: string, raw: unknown) {
  if (!hasPermission(user, "penalties.manage") && !hasPermission(user, "penalties.approve")) throw new ForbiddenError();
  const { reason } = parseInput(cancelViolationSchema, raw);
  return prisma.$transaction(async (tx) => {
    const v = await lockViolation(tx, checkId(id));
    if (v.status === "APPROVED" && !hasPermission(user, "penalties.approve")) throw new ForbiddenError();
    if (v.status === "APPROVED" && v.userId === user.id) throw new ForbiddenError("penalties.errors.own");
    if (v.status !== "PROPOSED" && v.status !== "APPROVED") throw formError("penalties.errors.notCancellable");
    const now = new Date();
    await tx.violation.update({ where: { id: v.id }, data: { status: "CANCELLED", cancelledById: user.id, cancelledAt: now, cancelReason: reason } });
    await tx.violationEvent.create({ data: { violationId: v.id, event: "CANCELLED", kind: v.kind, amount: v.amount, note: reason, actorId: user.id, createdAt: now } });
    const reversed = v.status === "APPROVED" && v.kind === "DEDUCTION";
    if (reversed) {
      await tx.deductionEntry.create({ data: { violationId: v.id, userId: v.userId, month: monthOf(v.occurredOn), amount: v.amount.negated(), kind: "REVERSAL", createdById: user.id, createdAt: now } });
    }
    await recordAudit(tx, {
      entityType: "PENALTY",
      entityId: v.id,
      action: "VIOLATION_CANCELLED",
      summary: msg("erpAudit.violationCancelled", { name: user.name, number: v.number, person: v.user.name, reason }),
      changes: { status: { from: v.status, to: "CANCELLED" }, reason, ...(reversed ? { reversed: D(v.amount) } : {}) },
      actorId: user.id,
    });
    if (v.status === "APPROVED") await notifyUsers(tx, [v.userId], { type: "PENALTY", message: msg("penalties.notify.cancelled", { number: v.number, reason }) }, user.id);
    return { id: v.id, status: "CANCELLED" as const };
  });
}

// ---------------------------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------------------------

const include = {
  user: { select: { id: true, name: true } },
  rule: { select: { id: true, name: true, nameAr: true } },
  appointment: { select: { id: true, number: true } },
  createdBy: { select: { name: true } },
  decidedBy: { select: { name: true } },
  cancelledBy: { select: { name: true } },
} satisfies Prisma.ViolationInclude;

type Row = Prisma.ViolationGetPayload<{ include: typeof include }>;

function violationDTO(user: CurrentUser, v: Row) {
  const approve = hasPermission(user, "penalties.approve") && v.userId !== user.id;
  return {
    id: v.id,
    number: v.number,
    user: v.user,
    rule: v.rule,
    trigger: v.trigger,
    occurredOn: keyOf(v.occurredOn),
    minutes: v.minutes,
    kind: v.kind,
    amount: D(v.amount),
    proposedKind: v.proposedKind,
    proposedAmount: D(v.proposedAmount),
    description: v.description,
    appointment: v.appointment ? { id: v.appointment.id, code: appointmentCode(v.appointment.number) } : null,
    status: v.status,
    createdBy: v.createdBy.name,
    createdAt: v.createdAt.toISOString(),
    decidedBy: v.decidedBy?.name ?? null,
    decidedAt: v.decidedAt?.toISOString() ?? null,
    decisionNote: v.decisionNote,
    cancelledBy: v.cancelledBy?.name ?? null,
    cancelledAt: v.cancelledAt?.toISOString() ?? null,
    cancelReason: v.cancelReason,
    can: {
      decide: approve && v.status === "PROPOSED",
      cancel: (v.status === "PROPOSED" && (hasPermission(user, "penalties.manage") || approve)) || (v.status === "APPROVED" && approve),
    },
  };
}
export type ViolationDTO = ReturnType<typeof violationDTO>;

/** What employees see of their own record: decided warnings and deductions (and their cancellation). */
const OWN_VISIBLE: Prisma.ViolationWhereInput = { OR: [{ status: "APPROVED" }, { status: "CANCELLED", decidedById: { not: null } }] };

export async function listViolations(user: CurrentUser, opts: { status?: string; userId?: string; month?: string; page?: unknown } = {}) {
  const all = canSeeAll(user);
  if (!all && !hasPermission(user, "penalties.own")) throw new NotFoundError();
  const and: Prisma.ViolationWhereInput[] = [];
  if (!all) and.push({ userId: user.id }, OWN_VISIBLE);
  else if (opts.userId) and.push({ userId: opts.userId });
  if (opts.status && ["PROPOSED", "APPROVED", "REJECTED", "CANCELLED"].includes(opts.status)) and.push({ status: opts.status as ViolationStatus });
  if (opts.month && /^\d{4}-(0[1-9]|1[0-2])$/.test(opts.month)) {
    const first = `${opts.month}-01`;
    and.push({ occurredOn: { gte: dbDate(first), lt: dbDate(`${addDaysToKey(first, 31).slice(0, 7)}-01`) } });
  }
  const where: Prisma.ViolationWhereInput = { AND: and };
  const { page, skip, take } = pageOf(opts.page, PAGE_SIZE);
  const [rows, total, sums] = await Promise.all([
    prisma.violation.findMany({ where, include, orderBy: [{ occurredOn: "desc" }, { number: "desc" }], skip, take }),
    prisma.violation.count({ where }),
    prisma.violation.groupBy({ by: ["status", "kind"], where, _count: { _all: true }, _sum: { amount: true } }),
  ]);
  const sum = (status: ViolationStatus, kind?: ViolationKind) => sums.filter((s) => s.status === status && (!kind || s.kind === kind));
  return {
    rows: rows.map((r) => violationDTO(user, r)),
    total,
    page,
    pageCount: Math.max(1, Math.ceil(total / PAGE_SIZE)),
    summary: {
      proposed: sum("PROPOSED").reduce((n, s) => n + s._count._all, 0),
      approvedWarnings: sum("APPROVED", "WARNING").reduce((n, s) => n + s._count._all, 0),
      approvedDeductions: sum("APPROVED", "DEDUCTION").reduce((n, s) => n + s._count._all, 0),
      approvedAmount: sum("APPROVED", "DEDUCTION").reduce((n, s) => n + D(s._sum.amount), 0),
    },
  };
}

/** One violation with every step of its history. */
export async function getViolation(user: CurrentUser, id: string) {
  const all = canSeeAll(user);
  if (!all && !hasPermission(user, "penalties.own")) throw new NotFoundError();
  const v = await prisma.violation.findFirst({ where: { AND: [{ id: checkId(id) }, ...(all ? [] : [{ userId: user.id }, OWN_VISIBLE])] }, include });
  if (!v) throw new NotFoundError();
  const [events, entries] = await Promise.all([
    prisma.violationEvent.findMany({ where: { violationId: v.id }, orderBy: [{ createdAt: "asc" }, { id: "asc" }], include: { actor: { select: { name: true } } } }),
    prisma.deductionEntry.findMany({ where: { violationId: v.id }, orderBy: { createdAt: "asc" } }),
  ]);
  return {
    ...violationDTO(user, v),
    events: events.map((e) => ({ id: e.id, event: e.event, kind: e.kind, amount: D(e.amount), note: e.note, by: e.actor.name, at: e.createdAt.toISOString() })),
    entries: entries.map((e) => ({ id: e.id, kind: e.kind, month: e.month, amount: D(e.amount), at: e.createdAt.toISOString() })),
  };
}
export type ViolationDetail = Awaited<ReturnType<typeof getViolation>>;

/**
 * Deductions for a payroll month, per employee, from the deduction entries only (approved
 * deductions less cancelled ones). This is what finance reads.
 */
export async function deductionsForMonth(month: string) {
  const rows = await prisma.$queryRaw<{ userId: string; name: string; amount: Prisma.Decimal; count: number }[]>`
    SELECT e."userId", u.name, sum(e.amount) AS amount, count(*) FILTER (WHERE e.kind = 'APPROVAL')::int - count(*) FILTER (WHERE e.kind = 'REVERSAL')::int AS count
    FROM deduction_entries e JOIN users u ON u.id = e."userId"
    WHERE e.month = ${month}
    GROUP BY e."userId", u.name
    HAVING sum(e.amount) <> 0
    ORDER BY sum(e.amount) DESC, u.name`;
  const people = rows.map((r) => ({ userId: r.userId, name: r.name, amount: D(r.amount), count: r.count }));
  return { people, total: Math.round(people.reduce((s, p) => s + p.amount, 0) * 100) / 100 };
}

/** Active employees a violation can be recorded for. */
export async function violationPeople(user: CurrentUser) {
  assertCan(user, "penalties.manage");
  return prisma.user.findMany({ where: { isActive: true }, select: { id: true, name: true, role: true }, orderBy: { name: "asc" } });
}
