import "server-only";
import { Prisma, type StocktakeKind, type StocktakeRecurrence, type StocktakeScheduleStatus } from "@prisma/client";
import { msg } from "@/i18n/translator";
import { STOCKTAKE_PREFIX, formatDocNumber } from "@/lib/inventory";
import { PLAN_AHEAD_DAYS, nextOccurrence, occurrences, stocktakeScheduleSchema, type ScheduleRule } from "@/lib/stocktake-schedule";
import { computeEnd, dateKey, zonedToUtc } from "@/lib/time";
import { prisma, type Tx } from "../db";
import { assertCan, hasPermission } from "../access";
import type { CurrentUser } from "../auth/session";
import { NotFoundError, StaleRecordError, ValidationError } from "../errors";
import { recordAudit } from "./audit";
import { checkId, nextSequence, parseInput, warehouseScope } from "./inventory-common";

/**
 * Stocktake schedules. A schedule is a plan (warehouse, kind, recurrence, time, people, scope); it
 * creates one PLANNED stocktake per occurrence, PLAN_AHEAD_DAYS ahead (and always the next
 * occurrence of an annual schedule). Sessions are unique per (schedule, occurrence day), so
 * running the planner again, or twice at once, never creates a duplicate. A planned session is
 * then started, counted and approved like any stocktake.
 *
 * Editing a schedule updates its future PLANNED sessions that nobody changed by hand, and cancels
 * the ones that no longer fall on the new dates. Pausing stops new sessions (planned ones stay);
 * ending cancels the planned ones. Schedules are never deleted.
 */

const DAY = 86_400_000;
const dayAfter = (key: string, days: number) => new Date(Date.parse(`${key}T00:00:00Z`) + days * DAY).toISOString().slice(0, 10);
const asDate = (key: string) => new Date(`${key}T00:00:00Z`);
const keyOf = (d: Date) => d.toISOString().slice(0, 10);

type ScheduleRow = Prisma.StocktakeScheduleGetPayload<object>;

function ruleOf(s: Pick<ScheduleRow, "recurrence" | "interval" | "startDate" | "endDate">): ScheduleRule {
  return { recurrence: s.recurrence, interval: s.interval, startDate: keyOf(s.startDate), endDate: s.endDate ? keyOf(s.endDate) : null };
}

/** Occurrence days to have planned sessions for, from today. */
function wantedDays(s: ScheduleRow, todayKey: string): string[] {
  const rule = ruleOf(s);
  const days = occurrences(rule, todayKey, dayAfter(todayKey, PLAN_AHEAD_DAYS));
  const next = nextOccurrence(rule, todayKey);
  if (next && !days.includes(next)) days.push(next);
  return days;
}

/**
 * Creates the missing PLANNED sessions of active schedules (all, or the given ones). Idempotent:
 * existing occurrences are skipped, the schedule row is locked while planning, and the unique key
 * (scheduleId, occurrenceDate) stops a duplicate even from a concurrent run.
 */
export async function planSessions(tz: string, scheduleIds?: string[], now = new Date()): Promise<number> {
  const todayKey = dateKey(now, tz);
  const schedules = await prisma.stocktakeSchedule.findMany({ where: { status: "ACTIVE", ...(scheduleIds ? { id: { in: scheduleIds } } : {}) }, select: { id: true } });
  let created = 0;
  for (const { id } of schedules) {
    created += await prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM stocktake_schedules WHERE id = ${id} FOR UPDATE`;
      const s = await tx.stocktakeSchedule.findUniqueOrThrow({ where: { id } });
      if (s.status !== "ACTIVE") return 0;
      const days = wantedDays(s, todayKey);
      if (!days.length) return 0;
      const have = new Set((await tx.stocktake.findMany({ where: { scheduleId: id, occurrenceDate: { in: days.map(asDate) } }, select: { occurrenceDate: true } })).map((r) => keyOf(r.occurrenceDate!)));
      let n = 0;
      for (const day of days) {
        if (have.has(day)) continue;
        const plannedStart = zonedToUtc(day, s.startTime, tz);
        const year = Number(day.slice(0, 4));
        const number = formatDocNumber(STOCKTAKE_PREFIX, year, await nextSequence(tx, `${STOCKTAKE_PREFIX}-${year}`));
        const rows = await tx.$queryRaw<{ id: string }[]>`
          INSERT INTO "stocktakes" ("id", "number", "warehouseId", "status", "snapshotAt", "name", "kind", "scheduleId", "occurrenceDate",
            "plannedStart", "plannedEnd", "assigneeIds", "supervisorId", "categoryIds", "productIds", "mandatory", "instructions",
            "createdById", "createdAt", "updatedAt", "version", "round")
          VALUES (${`stk_${id.slice(-10)}_${day.replaceAll("-", "")}`}, ${number}, ${s.warehouseId}, 'PLANNED', NULL, ${s.name}, ${s.kind}::"StocktakeKind", ${id}, ${asDate(day)}::date,
            ${plannedStart}, ${computeEnd(plannedStart, s.durationMinutes)}, ${s.assigneeIds}, ${s.supervisorId}, ${s.categoryIds}, ${s.productIds}, ${s.mandatory}, ${s.instructions},
            ${s.createdById}, ${now}, ${now}, 1, 0)
          ON CONFLICT ("scheduleId", "occurrenceDate") DO NOTHING
          RETURNING "id"`;
        n += rows.length;
      }
      return n;
    });
  }
  return created;
}

function assertPlanner(user: CurrentUser) {
  assertCan(user, "stocktakes.schedule");
}

export type ScheduleDTO = Awaited<ReturnType<typeof listSchedules>>[number];

export async function listSchedules(user: CurrentUser) {
  if (!hasPermission(user, "stocktakes.schedule") && !hasPermission(user, "inventory.approve") && !hasPermission(user, "inventory.count")) throw new NotFoundError();
  const tz = user.settings.timezone;
  const rows = await prisma.stocktakeSchedule.findMany({
    where: { warehouse: warehouseScope(user) },
    include: { warehouse: { select: { id: true, code: true, nameEn: true, nameAr: true } }, supervisor: { select: { id: true, name: true } }, _count: { select: { sessions: true } } },
    orderBy: [{ status: "asc" }, { name: "asc" }],
  });
  const todayKey = dateKey(new Date(), tz);
  return rows.map((s) => ({
    id: s.id,
    name: s.name,
    nameAr: s.nameAr,
    warehouse: s.warehouse,
    kind: s.kind,
    recurrence: s.recurrence,
    interval: s.interval,
    startDate: keyOf(s.startDate),
    endDate: s.endDate ? keyOf(s.endDate) : null,
    startTime: s.startTime,
    durationMinutes: s.durationMinutes,
    assigneeIds: s.assigneeIds,
    supervisor: s.supervisor,
    categoryIds: s.categoryIds,
    productIds: s.productIds,
    mandatory: s.mandatory,
    instructions: s.instructions,
    status: s.status,
    version: s.version,
    sessions: s._count.sessions,
    next: s.status === "ACTIVE" ? nextOccurrence(ruleOf(s), todayKey) : null,
  }));
}

async function validateRefs(tx: Tx, user: CurrentUser, v: { warehouseId: string; assigneeIds: string[]; supervisorId: string | null; categoryIds: string[]; productIds: string[] }) {
  const w = await tx.warehouse.findFirst({ where: { AND: [{ id: v.warehouseId }, warehouseScope(user)] } });
  if (!w || !w.isActive) throw new ValidationError({ warehouseId: msg("stock.errors.warehouse") });
  const people = [...new Set([...v.assigneeIds, ...(v.supervisorId ? [v.supervisorId] : [])])];
  const active = new Set((await tx.user.findMany({ where: { id: { in: people }, isActive: true }, select: { id: true } })).map((u) => u.id));
  if (v.assigneeIds.some((id) => !active.has(id))) throw new ValidationError({ assigneeIds: msg("stocktakePlan.errors.assignees") });
  if (v.supervisorId && !active.has(v.supervisorId)) throw new ValidationError({ supervisorId: msg("stocktakePlan.errors.supervisor") });
  if (v.categoryIds.length && (await tx.catalogCategory.count({ where: { id: { in: v.categoryIds } } })) !== new Set(v.categoryIds).size) throw new ValidationError({ categoryIds: msg("stocktakePlan.errors.categories") });
  if (v.productIds.length && (await tx.product.count({ where: { id: { in: v.productIds } } })) !== new Set(v.productIds).size) throw new ValidationError({ productIds: msg("stocktakePlan.errors.products") });
  return w;
}

export async function createSchedule(user: CurrentUser, raw: unknown, now = new Date()) {
  assertPlanner(user);
  const v = parseInput(stocktakeScheduleSchema, raw);
  const id = await prisma.$transaction(async (tx) => {
    const w = await validateRefs(tx, user, v);
    const s = await tx.stocktakeSchedule.create({
      data: {
        name: v.name,
        nameAr: v.nameAr ?? null,
        warehouseId: w.id,
        kind: v.kind as StocktakeKind,
        recurrence: v.recurrence as StocktakeRecurrence,
        interval: v.interval,
        startDate: asDate(v.startDate),
        endDate: v.endDate ? asDate(v.endDate) : null,
        startTime: v.startTime,
        durationMinutes: v.durationMinutes,
        assigneeIds: [...new Set(v.assigneeIds)],
        supervisorId: v.supervisorId,
        categoryIds: [...new Set(v.categoryIds)],
        productIds: [...new Set(v.productIds)],
        mandatory: v.mandatory,
        instructions: v.instructions ?? null,
        createdById: user.id,
      },
    });
    await recordAudit(tx, {
      entityType: "STOCKTAKE",
      entityId: s.id,
      module: "inventory",
      action: "STOCKTAKE_SCHEDULE_CREATED",
      summary: msg("stocktakePlan.audit.scheduleCreated", { name: user.name, schedule: s.name, code: w.code }),
      reason: v.reason ?? null,
      changes: { name: s.name, kind: s.kind, recurrence: s.recurrence, interval: s.interval, startDate: v.startDate, endDate: v.endDate, startTime: s.startTime, durationMinutes: s.durationMinutes },
      actorId: user.id,
    });
    return s.id;
  });
  await planSessions(user.settings.timezone, [id], now);
  return { id };
}

const FIELDS = ["name", "nameAr", "kind", "recurrence", "interval", "startTime", "durationMinutes", "assigneeIds", "supervisorId", "categoryIds", "productIds", "mandatory", "instructions", "status"] as const;

/**
 * Changes a schedule. Future PLANNED sessions that nobody changed by hand follow the new plan;
 * sessions on days the schedule no longer occurs on are cancelled; ending the schedule cancels
 * its planned sessions. Started and finished sessions never change.
 */
export async function updateSchedule(user: CurrentUser, id: string, raw: unknown, now = new Date()) {
  assertPlanner(user);
  const v = parseInput(stocktakeScheduleSchema, raw);
  const tz = user.settings.timezone;
  await prisma.$transaction(async (tx) => {
    const rows = await tx.$queryRaw<{ id: string }[]>`SELECT id FROM stocktake_schedules WHERE id = ${checkId(id)} FOR UPDATE`;
    if (!rows.length) throw new NotFoundError();
    const before = await tx.stocktakeSchedule.findUniqueOrThrow({ where: { id } });
    if (v.version !== undefined && v.version !== before.version) throw new StaleRecordError();
    if (v.warehouseId !== before.warehouseId) throw new ValidationError({ warehouseId: msg("stocktakePlan.errors.warehouseFixed") });
    await validateRefs(tx, user, v);
    const status = (v.status ?? before.status) as StocktakeScheduleStatus;
    const after = await tx.stocktakeSchedule.update({
      where: { id },
      data: {
        name: v.name,
        nameAr: v.nameAr === undefined ? before.nameAr : v.nameAr,
        kind: v.kind as StocktakeKind,
        recurrence: v.recurrence as StocktakeRecurrence,
        interval: v.interval,
        startDate: asDate(v.startDate),
        endDate: v.endDate ? asDate(v.endDate) : null,
        startTime: v.startTime,
        durationMinutes: v.durationMinutes,
        assigneeIds: [...new Set(v.assigneeIds)],
        supervisorId: v.supervisorId,
        categoryIds: [...new Set(v.categoryIds)],
        productIds: [...new Set(v.productIds)],
        mandatory: v.mandatory,
        instructions: v.instructions === undefined ? before.instructions : v.instructions,
        status,
        updatedById: user.id,
        version: { increment: 1 },
      },
    });
    // Future planned sessions of this schedule that were not changed by hand (not postponed).
    const todayKey = dateKey(now, tz);
    const planned = await tx.stocktake.findMany({ where: { scheduleId: id, status: "PLANNED", occurrenceDate: { gte: asDate(todayKey) } } });
    const keep = new Set(status === "ENDED" ? [] : occurrences(ruleOf(after), todayKey, dayAfter(todayKey, 3660)));
    let cancelled = 0;
    let updated = 0;
    for (const p of planned) {
      const day = keyOf(p.occurrenceDate!);
      if (!keep.has(day)) {
        await tx.stocktake.update({ where: { id: p.id }, data: { status: "CANCELLED", decidedById: user.id, decidedAt: now, decisionNote: msg("stocktakePlan.cancelledByScheduleChange"), version: { increment: 1 } } });
        cancelled++;
      } else if (!p.postponedFrom) {
        const plannedStart = zonedToUtc(day, after.startTime, tz);
        await tx.stocktake.update({
          where: { id: p.id },
          data: {
            name: after.name,
            kind: after.kind,
            plannedStart,
            plannedEnd: computeEnd(plannedStart, after.durationMinutes),
            assigneeIds: after.assigneeIds,
            supervisorId: after.supervisorId,
            categoryIds: after.categoryIds,
            productIds: after.productIds,
            mandatory: after.mandatory,
            instructions: after.instructions,
            version: { increment: 1 },
          },
        });
        updated++;
      }
    }
    const changes: Record<string, unknown> = {};
    for (const k of FIELDS) {
      const a = JSON.stringify(before[k]);
      const b = JSON.stringify(after[k]);
      if (a !== b) changes[k] = { from: before[k], to: after[k] };
    }
    if (keyOf(before.startDate) !== keyOf(after.startDate)) changes.startDate = { from: keyOf(before.startDate), to: keyOf(after.startDate) };
    if ((before.endDate && keyOf(before.endDate)) !== (after.endDate && keyOf(after.endDate))) changes.endDate = { from: before.endDate && keyOf(before.endDate), to: after.endDate && keyOf(after.endDate) };
    await recordAudit(tx, {
      entityType: "STOCKTAKE",
      entityId: id,
      module: "inventory",
      action: "STOCKTAKE_SCHEDULE_UPDATED",
      summary: msg("stocktakePlan.audit.scheduleUpdated", { name: user.name, schedule: after.name, updated, cancelled }),
      reason: v.reason ?? null,
      changes: { ...changes, sessionsUpdated: updated, sessionsCancelled: cancelled },
      actorId: user.id,
    });
  });
  await planSessions(tz, [id], now);
  return { ok: true };
}
