"use client";

import Link from "next/link";
import { MapPin, Users } from "lucide-react";
import { useI18n } from "@/i18n/client";
import type { AppointmentListItem } from "@/lib/types";
import { colorOrFallback } from "@/lib/colors";
import { productLine } from "@/lib/format";
import { StatusBadge } from "@/components/ui/misc";
import { Ltr } from "@/components/ui/ltr";
import { cn } from "@/lib/utils";

/** One appointment row: Sales colour bar, time, customer, product, area, technicians, status. */
export function AgendaItem({ a, showDate, className }: { a: AppointmentListItem; showDate?: boolean; className?: string }) {
  const { t, f, label, sn } = useI18n();
  const cancelled = a.status.kind === "CANCELLED";
  return (
    <Link
      href={`/appointments/${a.id}`}
      prefetch={false}
      className={cn("group flex gap-3 rounded-lg border border-line bg-surface p-3 transition-colors hover:border-line-strong hover:bg-surface-muted", className)}
    >
      <span className="w-1.5 shrink-0 rounded-full" style={{ backgroundColor: colorOrFallback(a.createdBy.color) }} title={t("list.salesBy", { name: a.createdBy.name })} aria-hidden />
      <div className="w-24 shrink-0">
        {showDate && <p className="text-xs font-medium text-fg-subtle">{f.shortDate(a.startsAt)}</p>}
        <p className={cn("text-sm font-semibold tabular-nums text-fg", cancelled && "line-through decoration-fg-subtle")}>
          <Ltr>{f.timeRange(a.startsAt, a.endsAt)}</Ltr>
        </p>
        <p className="text-xs text-fg-subtle">
          <Ltr>{a.code}</Ltr>
        </p>
      </div>
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
          <p className="truncate font-medium text-fg group-hover:text-brand-text">{a.customerName}</p>
          <StatusBadge name={sn(a.status)} color={a.status.color} />
        </div>
        <p className="mt-0.5 truncate text-sm text-fg-muted">{productLine(a, label)}</p>
        <div className="mt-1 flex flex-wrap gap-x-4 gap-y-1 text-xs text-fg-subtle">
          {a.area !== undefined && (a.area || a.building) && (
            <span className="inline-flex items-center gap-1">
              <MapPin className="h-3.5 w-3.5" /> {f.join([a.building, a.area])}
            </span>
          )}
          <span className="inline-flex items-center gap-1">
            <Users className="h-3.5 w-3.5" /> {a.technicians.length ? f.join(a.technicians.map((x) => x.name)) : t("list.noTechnician")}
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
