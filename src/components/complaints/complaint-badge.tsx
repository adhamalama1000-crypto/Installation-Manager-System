import type { ComplaintStatusValue } from "@/lib/types";
import { cn } from "@/lib/utils";

const tones: Record<ComplaintStatusValue, string> = {
  NEW: "bg-danger-soft text-danger",
  ASSIGNED: "bg-warning-soft text-warning",
  RESOLVED: "bg-success-soft text-success",
  CLOSED: "bg-surface-muted text-fg-muted",
};

/** A complaint's status; the label comes from the caller (enums.complaintStatus). */
export function ComplaintBadge({ status, label, className }: { status: ComplaintStatusValue; label: string; className?: string }) {
  return <span className={cn("inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium", tones[status], className)}>{label}</span>;
}
