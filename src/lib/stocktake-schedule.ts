/**
 * Stocktake schedules: the dates a schedule occurs on, and the input schemas. Pure (shared by the
 * server, the browser and the tests).
 *
 * Rules:
 *   - an occurrence is a company calendar day (YYYY-MM-DD); the session starts at the schedule's
 *     start time that day (company timezone) and may take durationMinutes;
 *   - DAILY / WEEKLY repeat every `interval` days / weeks from the start date;
 *   - MONTHLY repeats on the start date's day of the month every `interval` months; in a shorter
 *     month it falls on the month's last day (31st -> 30 April, 28/29 February);
 *   - YEARLY repeats on the start date's month and day every `interval` years (29 February -> 28
 *     February in other years);
 *   - NONE occurs once, on the start date;
 *   - nothing occurs before the start date or after the end date.
 */
import { z } from "zod";
import { msg } from "@/i18n/translator";
import type { StocktakeKind, StocktakeRecurrence } from "@prisma/client";

export const STOCKTAKE_KINDS: StocktakeKind[] = ["DAILY", "MONTHLY", "ANNUAL", "CUSTOM"];
export const STOCKTAKE_RECURRENCES: StocktakeRecurrence[] = ["NONE", "DAILY", "WEEKLY", "MONTHLY", "YEARLY"];
/** How far ahead planned sessions are created (an annual schedule's next session is always created). */
export const PLAN_AHEAD_DAYS = 45;

export type ScheduleRule = { recurrence: StocktakeRecurrence; interval: number; startDate: string; endDate: string | null };

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

function parts(key: string) {
  const [y, m, d] = key.split("-").map(Number) as [number, number, number];
  return { y, m, d };
}
const daysIn = (y: number, m: number) => new Date(Date.UTC(y, m, 0)).getUTCDate();
const key = (y: number, m: number, d: number) => `${String(y).padStart(4, "0")}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
const toDay = (k: string) => Math.round(Date.UTC(parts(k).y, parts(k).m - 1, parts(k).d) / 86_400_000);
const fromDay = (n: number) => new Date(n * 86_400_000).toISOString().slice(0, 10);

/** The days in [from, to] (inclusive) on which the schedule occurs, in order. At most `limit`. */
export function occurrences(rule: ScheduleRule, from: string, to: string, limit = 400): string[] {
  const out: string[] = [];
  const start = rule.startDate;
  const last = rule.endDate && rule.endDate < to ? rule.endDate : to;
  const first = from > start ? from : start;
  if (first > last) return out;
  const n = Math.max(1, Math.floor(rule.interval || 1));
  const push = (k: string) => {
    if (k >= first && k <= last && out.length < limit) out.push(k);
  };
  switch (rule.recurrence) {
    case "NONE":
      push(start);
      return out;
    case "DAILY":
    case "WEEKLY": {
      const step = rule.recurrence === "DAILY" ? n : 7 * n;
      const s = toDay(start);
      // First occurrence on or after `first`.
      let k = s + Math.max(0, Math.ceil((toDay(first) - s) / step)) * step;
      for (; k <= toDay(last) && out.length < limit; k += step) push(fromDay(k));
      return out;
    }
    case "MONTHLY":
    case "YEARLY": {
      const { y: sy, m: sm, d: sd } = parts(start);
      const months = rule.recurrence === "MONTHLY" ? n : 12 * n;
      const { y: fy, m: fm } = parts(first);
      // Months elapsed from the start month to `first`'s month, rounded up to the step.
      let i = Math.max(0, Math.floor(((fy - sy) * 12 + (fm - sm)) / months) * months);
      for (; out.length < limit; i += months) {
        const total = sm - 1 + i;
        const y = sy + Math.floor(total / 12);
        const m = (total % 12) + 1;
        const k = key(y, m, Math.min(sd, daysIn(y, m)));
        if (k > last) break;
        push(k);
      }
      return out;
    }
  }
}

/** The next occurrence on or after `from` (null when the schedule has ended). */
export function nextOccurrence(rule: ScheduleRule, from: string): string | null {
  const horizon = fromDay(toDay(from) + 366 * Math.max(1, rule.recurrence === "YEARLY" ? rule.interval : 1) + 31);
  return occurrences(rule, from, horizon, 1)[0] ?? null;
}

const trimmed = (max: number) => z.preprocess((v) => (typeof v === "string" ? v.trim() || null : (v ?? null)), z.string().max(max).nullable());
const ids = z.array(z.string().min(1).max(64)).max(500).default([]);

export const stocktakeScheduleSchema = z
  .object({
    name: z.preprocess((v) => (typeof v === "string" ? v.trim() : v), z.string({ error: msg("stocktakePlan.errors.name") }).min(1, msg("stocktakePlan.errors.name")).max(120, msg("stocktakePlan.errors.name"))),
    nameAr: trimmed(120).optional(),
    warehouseId: z.string({ error: msg("stock.errors.warehouse") }).min(1, msg("stock.errors.warehouse")).max(64),
    kind: z.enum(STOCKTAKE_KINDS as [string, ...string[]], { error: msg("stocktakePlan.errors.kind") }),
    recurrence: z.enum(STOCKTAKE_RECURRENCES as [string, ...string[]], { error: msg("stocktakePlan.errors.recurrence") }),
    interval: z.coerce.number({ error: msg("stocktakePlan.errors.interval") }).int(msg("stocktakePlan.errors.interval")).min(1, msg("stocktakePlan.errors.interval")).max(366, msg("stocktakePlan.errors.interval")).default(1),
    startDate: z.string({ error: msg("stocktakePlan.errors.startDate") }).regex(DATE_RE, msg("stocktakePlan.errors.startDate")),
    endDate: z.preprocess((v) => (v === "" || v === undefined ? null : v), z.string().regex(DATE_RE, msg("stocktakePlan.errors.endDate")).nullable()),
    startTime: z.string({ error: msg("stocktakePlan.errors.time") }).regex(TIME_RE, msg("stocktakePlan.errors.time")),
    durationMinutes: z.coerce.number({ error: msg("stocktakePlan.errors.duration") }).int(msg("stocktakePlan.errors.duration")).min(15, msg("stocktakePlan.errors.duration")).max(10080, msg("stocktakePlan.errors.duration")),
    assigneeIds: ids,
    supervisorId: z.preprocess((v) => (v === "" || v === undefined ? null : v), z.string().max(64).nullable()),
    categoryIds: ids,
    productIds: ids,
    mandatory: z.boolean().default(false),
    instructions: trimmed(2000).optional(),
    status: z.enum(["ACTIVE", "PAUSED", "ENDED"]).optional(),
    version: z.number().int().positive().optional(),
    reason: trimmed(500).optional(),
  })
  .refine((v) => !v.endDate || v.endDate >= v.startDate, { path: ["endDate"], message: msg("stocktakePlan.errors.endBeforeStart") })
  .refine((v) => v.recurrence !== "NONE" || !v.endDate, { path: ["endDate"], message: msg("stocktakePlan.errors.endDateOnce") });

/** Changing one planned session (not the schedule). */
export const plannedSessionSchema = z.object({
  date: z.string().regex(DATE_RE, msg("stocktakePlan.errors.startDate")),
  startTime: z.string().regex(TIME_RE, msg("stocktakePlan.errors.time")),
  durationMinutes: z.coerce.number().int().min(15, msg("stocktakePlan.errors.duration")).max(10080, msg("stocktakePlan.errors.duration")),
  assigneeIds: ids,
  supervisorId: z.preprocess((v) => (v === "" || v === undefined ? null : v), z.string().max(64).nullable()),
  instructions: trimmed(2000).optional(),
  mandatory: z.boolean().optional(),
  /** Required when the session moves to a later time (a postponement). */
  reason: trimmed(500).optional(),
  version: z.number().int().positive().optional(),
});

/** Sending a submitted count back to the counters. */
export const recountSchema = z.object({
  note: z.preprocess((v) => (typeof v === "string" ? v.trim() : v), z.string({ error: msg("stocktakePlan.errors.recountNote") }).min(1, msg("stocktakePlan.errors.recountNote")).max(500)),
  /** Lines to count again (empty: the whole stocktake). */
  lineIds: z.array(z.string().min(1).max(64)).max(2000).default([]),
});

/** Ad-hoc stocktake (started now) with an optional name, scope and assignees. */
export const stocktakeStartSchema = z.object({
  warehouseId: z.string({ error: msg("stock.errors.warehouse") }).min(1, msg("stock.errors.warehouse")).max(64),
  note: trimmed(500).optional(),
  name: trimmed(120).optional(),
  kind: z.enum(STOCKTAKE_KINDS as [string, ...string[]]).optional(),
  categoryIds: ids,
  productIds: ids,
  assigneeIds: ids,
  supervisorId: z.preprocess((v) => (v === "" || v === undefined ? null : v), z.string().max(64).nullable()).optional(),
});

/** Technical specifications of a product: up to 30 key / value pairs. */
export const specificationsSchema = z
  .array(
    z.object({
      key: z.preprocess((v) => (typeof v === "string" ? v.trim() : v), z.string().min(1, msg("catalog.errors.specKey")).max(80, msg("catalog.errors.specKey"))),
      keyAr: trimmed(80).optional(),
      value: z.preprocess((v) => (typeof v === "string" ? v.trim() : v), z.string().min(1, msg("catalog.errors.specValue")).max(300, msg("catalog.errors.specValue"))),
    }),
  )
  .max(30, msg("catalog.errors.specCount"))
  .nullable()
  .optional();
export type Specification = { key: string; keyAr?: string | null; value: string };
