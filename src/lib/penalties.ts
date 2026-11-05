/**
 * Violations, warnings and deductions: the rule calculation and the forms, shared by the server
 * and the browser. A rule only proposes; a person approves every violation before anything is
 * deducted (src/server/services/penalties.ts, and database guards).
 */
import { z } from "zod";
import type { MessageKey } from "@/i18n/translator";
import { msg } from "@/i18n/translator";
import { isValidDateString } from "./time";

export const PENALTY_TRIGGERS = ["MANUAL", "LATE_ARRIVAL", "EARLY_LEAVE", "MISSING_CLOCK_OUT", "ABSENCE", "ATTENDANCE_REJECTED", "WORK_REJECTED"] as const;
export type PenaltyTriggerValue = (typeof PENALTY_TRIGGERS)[number];
export const PENALTY_ACTIONS = ["WARNING", "FIXED", "PER_MINUTE"] as const;
export type PenaltyActionValue = (typeof PENALTY_ACTIONS)[number];
export const VIOLATION_STATUSES = ["PROPOSED", "APPROVED", "REJECTED", "CANCELLED"] as const;
export type ViolationStatusValue = (typeof VIOLATION_STATUSES)[number];
export type ViolationKindValue = "WARNING" | "DEDUCTION";

/** Triggers measured in minutes (the only ones a per-minute rule can use). */
export const MINUTE_TRIGGERS: PenaltyTriggerValue[] = ["LATE_ARRIVAL", "EARLY_LEAVE"];
/** The longest period one scan looks at. */
export const MAX_SCAN_DAYS = 62;

export type PenaltyRuleValues = {
  action: PenaltyActionValue;
  amount: number;
  graceMinutes: number;
  maxAmount: number | null;
  warningsFirst: number;
};

const round2 = (n: number) => Math.round(n * 100) / 100;

/**
 * What a rule proposes for one occurrence: `minutes` late / early (minute triggers), and how many
 * earlier occurrences of the same rule the employee has that month (still standing). null: it does
 * not count (within the grace minutes).
 */
export function penaltyFor(rule: PenaltyRuleValues, minutes: number | null, earlierThisMonth: number): { kind: ViolationKindValue; amount: number; minutes: number | null } | null {
  const counted = minutes === null ? null : Math.max(0, minutes - rule.graceMinutes);
  if (counted === 0) return null;
  if (rule.action === "WARNING" || earlierThisMonth < rule.warningsFirst) return { kind: "WARNING", amount: 0, minutes: counted };
  let amount = rule.action === "PER_MINUTE" ? round2(rule.amount * (counted ?? 0)) : rule.amount;
  if (rule.maxAmount !== null && amount > rule.maxAmount) amount = rule.maxAmount;
  return amount > 0 ? { kind: "DEDUCTION", amount: round2(amount), minutes: counted } : { kind: "WARNING", amount: 0, minutes: counted };
}

const money = (label: MessageKey) =>
  z.preprocess(
    (v) => (v === "" || v === null || v === undefined ? 0 : typeof v === "string" ? Number(v.replace(/[,\s]/g, "")) : v),
    z
      .number({ error: msg(label) })
      .min(0, msg("validation.negative"))
      .max(1_000_000, msg("validation.tooLarge"))
      .refine((n) => Math.abs(n * 100 - Math.round(n * 100)) < 1e-6, msg("validation.twoDecimals")),
  );
const optionalMoney = z.preprocess((v) => (v === "" || v === undefined ? null : v), z.union([z.null(), money("validation.amount")]));
const text = (max: number) => z.preprocess((v) => (typeof v === "string" ? v.trim() || null : (v ?? null)), z.string().max(max, msg("validation.maxChars", { max })).nullable());
const whole = (max: number) => z.preprocess((v) => (v === "" || v === undefined || v === null ? 0 : Number(v)), z.number({ error: msg("validation.invalid") }).int(msg("penalties.errors.whole")).min(0, msg("validation.negative")).max(max, msg("validation.tooLarge")));
const dateKey = z.string({ error: msg("validation.dateRequired") }).refine(isValidDateString, msg("validation.date"));

export const penaltyRuleSchema = z
  .object({
    name: z.preprocess((v) => (typeof v === "string" ? v.trim() : v), z.string({ error: msg("penalties.errors.name") }).min(1, msg("penalties.errors.name")).max(120)),
    nameAr: text(120),
    trigger: z.enum(PENALTY_TRIGGERS, { error: msg("penalties.errors.trigger") }),
    action: z.enum(PENALTY_ACTIONS, { error: msg("penalties.errors.action") }),
    amount: money("validation.amount"),
    graceMinutes: whole(600),
    maxAmount: optionalMoney,
    warningsFirst: whole(31),
    description: text(500),
    isActive: z.preprocess((v) => (v === undefined ? true : v === true || v === "true" || v === "on"), z.boolean()),
  })
  .superRefine((r, ctx) => {
    if (r.action !== "WARNING" && !(r.amount > 0)) ctx.addIssue({ code: "custom", path: ["amount"], message: msg("penalties.errors.amount") });
    if (r.action === "PER_MINUTE" && !MINUTE_TRIGGERS.includes(r.trigger)) ctx.addIssue({ code: "custom", path: ["action"], message: msg("penalties.errors.perMinute") });
    if (r.maxAmount === 0) ctx.addIssue({ code: "custom", path: ["maxAmount"], message: msg("penalties.errors.amount") });
  })
  .transform((r) => ({ ...r, amount: r.action === "WARNING" ? 0 : r.amount, maxAmount: r.action === "PER_MINUTE" ? r.maxAmount : null }));

/** A violation recorded by hand (proposed; someone with the approval right decides). */
export const manualViolationSchema = z
  .object({
    userId: z.string({ error: msg("penalties.errors.employee") }).min(1, msg("penalties.errors.employee")).max(64),
    ruleId: z.preprocess((v) => (v === "" ? null : v), z.string().max(64).nullable().optional()),
    occurredOn: dateKey,
    kind: z.enum(["WARNING", "DEDUCTION"], { error: msg("penalties.errors.kind") }),
    amount: money("validation.amount"),
    description: z.preprocess((v) => (typeof v === "string" ? v.trim() : v), z.string({ error: msg("penalties.errors.description") }).min(1, msg("penalties.errors.description")).max(1000)),
    appointmentId: z.preprocess((v) => (v === "" ? null : v), z.string().max(64).nullable().optional()),
  })
  .superRefine((v, ctx) => {
    if (v.kind === "DEDUCTION" && !(v.amount > 0)) ctx.addIssue({ code: "custom", path: ["amount"], message: msg("penalties.errors.amount") });
  })
  .transform((v) => ({ ...v, amount: v.kind === "WARNING" ? 0 : v.amount }));

/** Approve (optionally as a warning or with another amount) or reject with the reason. */
export const violationDecisionSchema = z
  .object({
    decision: z.enum(["APPROVED", "REJECTED"]),
    kind: z.enum(["WARNING", "DEDUCTION"]).optional(),
    amount: z.preprocess((v) => (v === "" || v === null ? undefined : v), money("validation.amount").optional()),
    note: text(1000),
  })
  .superRefine((v, ctx) => {
    if (v.decision === "REJECTED" && !v.note) ctx.addIssue({ code: "custom", path: ["note"], message: msg("penalties.errors.reason") });
    if (v.decision === "APPROVED" && v.kind === "DEDUCTION" && v.amount !== undefined && !(v.amount > 0)) ctx.addIssue({ code: "custom", path: ["amount"], message: msg("penalties.errors.amount") });
  });

export const cancelViolationSchema = z.object({
  reason: z.preprocess((v) => (typeof v === "string" ? v.trim() : v), z.string({ error: msg("penalties.errors.cancelReason") }).min(1, msg("penalties.errors.cancelReason")).max(1000)),
});

export const scanSchema = z
  .object({ from: dateKey, to: dateKey })
  .superRefine((v, ctx) => {
    if (v.from > v.to) ctx.addIssue({ code: "custom", path: ["to"], message: msg("penalties.errors.range") });
    else if ((Date.parse(v.to) - Date.parse(v.from)) / 86_400_000 > MAX_SCAN_DAYS) ctx.addIssue({ code: "custom", path: ["from"], message: msg("penalties.errors.rangeTooLong", { max: MAX_SCAN_DAYS }) });
  });
