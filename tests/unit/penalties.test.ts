import { describe, expect, it } from "vitest";
import { cancelViolationSchema, manualViolationSchema, penaltyFor, penaltyRuleSchema, scanSchema, violationDecisionSchema } from "@/lib/penalties";

const perMinute = { action: "PER_MINUTE" as const, amount: 2, graceMinutes: 10, maxAmount: 100, warningsFirst: 0 };

describe("penaltyFor", () => {
  it("counts the minutes after the grace, per minute, up to the cap", () => {
    expect(penaltyFor(perMinute, 10, 0)).toBeNull(); // within the grace
    expect(penaltyFor(perMinute, 25, 0)).toEqual({ kind: "DEDUCTION", amount: 30, minutes: 15 });
    expect(penaltyFor(perMinute, 200, 0)).toEqual({ kind: "DEDUCTION", amount: 100, minutes: 190 });
    expect(penaltyFor({ ...perMinute, maxAmount: null }, 200, 0)).toEqual({ kind: "DEDUCTION", amount: 380, minutes: 190 });
    expect(penaltyFor({ ...perMinute, amount: 0.33 }, 13, 0)).toEqual({ kind: "DEDUCTION", amount: 0.99, minutes: 3 });
  });
  it("gives warnings first, then the penalty", () => {
    const rule = { ...perMinute, warningsFirst: 2 };
    expect(penaltyFor(rule, 30, 0)?.kind).toBe("WARNING");
    expect(penaltyFor(rule, 30, 1)).toEqual({ kind: "WARNING", amount: 0, minutes: 20 });
    expect(penaltyFor(rule, 30, 2)).toEqual({ kind: "DEDUCTION", amount: 40, minutes: 20 });
  });
  it("uses fixed amounts and warnings for events without minutes", () => {
    expect(penaltyFor({ action: "FIXED", amount: 200, graceMinutes: 0, maxAmount: null, warningsFirst: 0 }, null, 0)).toEqual({ kind: "DEDUCTION", amount: 200, minutes: null });
    expect(penaltyFor({ action: "WARNING", amount: 0, graceMinutes: 0, maxAmount: null, warningsFirst: 0 }, null, 5)).toEqual({ kind: "WARNING", amount: 0, minutes: null });
  });
});

describe("forms", () => {
  it("rule: amounts, per-minute only for minutes, warnings cost nothing", () => {
    expect(penaltyRuleSchema.parse({ name: " Late ", trigger: "LATE_ARRIVAL", action: "PER_MINUTE", amount: "1.5", graceMinutes: "", maxAmount: "" })).toMatchObject({
      name: "Late",
      amount: 1.5,
      graceMinutes: 0,
      maxAmount: null,
      warningsFirst: 0,
      isActive: true,
    });
    expect(penaltyRuleSchema.safeParse({ name: "x", trigger: "ABSENCE", action: "PER_MINUTE", amount: 1 }).success).toBe(false);
    expect(penaltyRuleSchema.safeParse({ name: "x", trigger: "ABSENCE", action: "FIXED", amount: "1.234" }).success).toBe(false);
    expect(penaltyRuleSchema.parse({ name: "x", trigger: "ABSENCE", action: "WARNING", amount: 9 }).amount).toBe(0);
    expect(penaltyRuleSchema.safeParse({ name: "", trigger: "ABSENCE", action: "WARNING" }).success).toBe(false);
  });
  it("manual violation, decision, cancellation and scan period", () => {
    expect(manualViolationSchema.parse({ userId: "u", occurredOn: "2031-03-03", kind: "WARNING", amount: "50", description: "Late" }).amount).toBe(0);
    expect(manualViolationSchema.safeParse({ userId: "u", occurredOn: "2031-02-30", kind: "WARNING", description: "x" }).success).toBe(false);
    expect(violationDecisionSchema.safeParse({ decision: "REJECTED" }).success).toBe(false);
    expect(violationDecisionSchema.parse({ decision: "APPROVED", amount: "" })).toEqual({ decision: "APPROVED", note: null });
    expect(cancelViolationSchema.safeParse({ reason: "  " }).success).toBe(false);
    expect(scanSchema.safeParse({ from: "2031-03-01", to: "2031-05-15" }).success).toBe(false);
    expect(scanSchema.safeParse({ from: "2031-03-01", to: "2031-03-31" }).success).toBe(true);
  });
});
