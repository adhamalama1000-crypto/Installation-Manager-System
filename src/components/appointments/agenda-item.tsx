import Link from "next/link";
import { MapPin, Users } from "lucide-react";
import type { AppointmentListItem } from "@/lib/types";
import { colorOrFallback } from "@/lib/colors";
import { productLine, timeRange } from "@/lib/format";
import { StatusBadge } from "@/components/ui/misc";
import { getT } from "@/i18n/server";
import { cn } from "@/lib/utils";

/** One appointment row: Sales colour bar, time, customer, product, area, technicians, status. */
export async function AgendaItem({ a, tz, showDate, className }: { a: AppointmentListItem; tz: string; showDate?: string; className?: string }) {
  const t = await getT();
  const cancelled = a.status.kind === "CANCELLED";
  return (
    <Link
      href={`/appointments/${a.id}`}
      prefetch={false}
      className={cn("group flex gap-3 rounded-lg border border-line bg-surface p-3 transition-colors hover:border-line-strong hover:bg-surface-muted", className)}
    >
      <span className="w-1.5 shrink-0 rounded-full" style={{ backgroundColor: colorOrFallback(a.createdBy.color) }} title={`${t("common.sales")}: ${a.createdBy.name}`} aria-hidden />
      <div className="w-24 shrink-0">
        {showDate && <p className="text-xs font-medium text-fg-subtle">{showDate}</p>}
        <p className={cn("text-sm font-semibold tabular-nums text-fg", cancelled && "line-through decoration-fg-subtle")}>{timeRange(a.startsAt, a.endsAt, tz)}</p>
        <p className="text-xs text-fg-subtle" dir="ltr">
          {a.code}
        </p>
      </div>
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
          <p className="truncate font-medium text-fg group-hover:text-brand-text">{a.customerName}</p>
          <StatusBadge name={a.status.name} color={a.status.color} />
        </div>
        <p className="mt-0.5 truncate text-sm text-fg-muted">{productLine(a, t)}</p>
        <div className="mt-1 flex flex-wrap gap-x-4 gap-y-1 text-xs text-fg-subtle">
          {a.area !== undefined && (a.area || a.building) && (
            <span className="inline-flex items-center gap-1">
              <MapPin className="h-3.5 w-3.5" /> {[a.building, a.area].filter(Boolean).join("، ")}
            </span>
          )}
          <span className="inline-flex items-center gap-1">
            <Users className="h-3.5 w-3.5" /> {a.technicians.length ? a.technicians.map((x) => x.name).join("، ") : t("appointments.noTechnician")}
          </span>
          <span className="inline-flex items-center gap-1">
            <span className="h-2 w-2 rounded-full" style={{ backgroundColor: colorOrFallback(a.createdBy.color) }} aria-hidden />
            {a.createdBy.name}
          </span>
        </div>
      </div>
    </Link>
  );
}
