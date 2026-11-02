import type { StockDocStatus, StocktakeStatus } from "@prisma/client";
import { cn } from "@/lib/utils";

const DOC: Record<StockDocStatus, string> = {
  DRAFT: "border-warning/40 bg-warning-soft text-fg",
  POSTED: "border-success/30 bg-success-soft text-fg",
  CANCELLED: "border-line bg-surface-muted text-fg-muted",
};
const TAKE: Record<StocktakeStatus, string> = {
  COUNTING: "border-info/30 bg-info-soft text-fg",
  SUBMITTED: "border-warning/40 bg-warning-soft text-fg",
  APPROVED: "border-success/30 bg-success-soft text-fg",
  REJECTED: "border-danger/30 bg-danger-soft text-fg",
  CANCELLED: "border-line bg-surface-muted text-fg-muted",
};

const base = "inline-flex items-center whitespace-nowrap rounded-full border px-2.5 py-0.5 text-xs font-medium";

export function DocStatusBadge({ status, label, className }: { status: StockDocStatus; label: string; className?: string }) {
  return <span className={cn(base, DOC[status], className)}>{label}</span>;
}

export function StocktakeBadge({ status, label, className }: { status: StocktakeStatus; label: string; className?: string }) {
  return <span className={cn(base, TAKE[status], className)}>{label}</span>;
}

/** A signed quantity: green when stock comes in, red when it goes out. */
export function SignedQty({ value, text }: { value: number; text: string }) {
  return <span className={cn("tabular-nums font-medium", value > 0 ? "text-success" : value < 0 ? "text-danger" : "text-fg-muted")}>{value > 0 ? `+${text}` : text}</span>;
}
