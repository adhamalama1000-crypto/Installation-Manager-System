/** Badge styles for a violation's status and penalty. */
export const violationStatusTone = {
  PROPOSED: "border-warning/40 bg-warning-soft text-fg",
  APPROVED: "border-success/40 bg-success-soft text-fg",
  REJECTED: "border-line text-fg-subtle",
  CANCELLED: "border-line text-fg-subtle line-through",
} as const;

export const violationKindTone = { WARNING: "border-info/40 bg-info-soft text-fg", DEDUCTION: "border-danger/40 bg-danger-soft text-fg" } as const;
