import Link from "next/link";
import {
  ArrowRight,
  Banknote,
  CheckCircle2,
  ClipboardCheck,
  FileText,
  Gavel,
  Inbox,
  PackageX,
  Plane,
  Receipt,
  ShieldCheck,
  ShoppingCart,
  TrendingDown,
  TrendingUp,
  TriangleAlert,
  UserCheck,
  Warehouse,
  Wrench,
} from "lucide-react";
import { MonthColumns } from "@/components/sales/month-columns";
import { Card, CardHeader } from "@/components/ui/card";
import type { T } from "@/i18n/translator";
import { money } from "@/lib/constants";
import { formatKey } from "@/lib/time";
import { cn } from "@/lib/utils";
import type { OperationsOverview } from "@/server/services/dashboard-operations";

/** Small "open the page" link used in card headers. */
function HeaderLink({ href, children }: { href: string; children: React.ReactNode }) {
  return (
    <Link href={href} className="inline-flex items-center gap-1 text-sm font-medium text-brand-text hover:underline">
      {children}
      <ArrowRight className="h-3.5 w-3.5 rtl:rotate-180" aria-hidden />
    </Link>
  );
}

/** A KPI tile: one number, its label and a hint. Links to the list it counts. */
export function KpiTile({
  href,
  label,
  value,
  hint,
  icon: Icon,
  tone = "brand",
}: {
  href: string;
  label: string;
  value: React.ReactNode;
  hint?: string;
  icon: React.ComponentType<{ className?: string }>;
  tone?: "brand" | "warning";
}) {
  return (
    <Link
      href={href}
      className={cn(
        "group flex flex-col rounded-xl border bg-surface p-4 shadow-card transition-colors hover:border-brand/40",
        tone === "warning" ? "border-warning/50" : "border-line",
      )}
    >
      <div className="flex items-center justify-between gap-2">
        <p className="truncate text-xs font-medium uppercase tracking-wide text-fg-muted">{label}</p>
        <Icon className={cn("h-4 w-4 shrink-0", tone === "warning" ? "text-warning" : "text-brand-text")} aria-hidden />
      </div>
      <p className="mt-2 text-[1.75rem] font-semibold leading-none tabular-nums text-fg">{value}</p>
      {hint && <p className="mt-1.5 truncate text-xs text-fg-subtle">{hint}</p>}
    </Link>
  );
}

/** One labelled figure inside a card (warehouse, finance). */
function Figure({ label, value, hint, icon: Icon, alert }: { label: string; value: React.ReactNode; hint?: string; icon: React.ComponentType<{ className?: string }>; alert?: boolean }) {
  return (
    <div className="rounded-lg border border-line bg-surface-muted/60 p-3">
      <p className="flex items-center gap-1.5 text-xs font-medium text-fg-muted">
        <Icon className={cn("h-3.5 w-3.5", alert ? "text-warning" : "text-brand-text")} aria-hidden />
        {label}
      </p>
      <p className="mt-1 text-xl font-semibold tabular-nums text-fg">{value}</p>
      {hint && <p className="text-xs text-fg-subtle">{hint}</p>}
    </div>
  );
}

/**
 * Attendance today as one segmented bar (2 px gaps between segments) with a legend that carries
 * every count as text, so the states never depend on colour alone.
 */
export function AttendanceCard({ data, t }: { data: NonNullable<OperationsOverview["attendance"]>; t: T }) {
  const present = data.onTime + data.late;
  const parts = [
    { key: "onTime", label: t("dashboard.ops.attendance.onTime"), value: data.onTime, color: "var(--success)" },
    { key: "late", label: t("dashboard.ops.attendance.late"), value: data.late, color: "var(--warning)" },
    { key: "onLeave", label: t("dashboard.ops.attendance.onLeave"), value: data.onLeave, color: "var(--series-1)" },
    { key: "notIn", label: t("dashboard.ops.attendance.notIn"), value: data.notIn, color: "var(--line-strong)" },
  ];
  const total = Math.max(data.staff, 1);
  return (
    <Card className="flex flex-col">
      <CardHeader
        title={t("dashboard.ops.attendance.title")}
        description={t("dashboard.ops.attendance.description", { count: data.staff, present })}
        icon={<UserCheck className="h-4 w-4" />}
        actions={<HeaderLink href="/attendance/daily">{t("dashboard.ops.attendance.open")}</HeaderLink>}
      />
      <div className="flex-1 p-5">
        {data.staff === 0 ? (
          <p className="py-6 text-center text-sm text-fg-muted">{t("dashboard.ops.attendance.empty")}</p>
        ) : (
          <>
            <p className="flex items-baseline gap-1.5">
              <span className="text-3xl font-semibold tabular-nums text-fg">{Math.round((present / total) * 100)}%</span>
              <span className="text-sm text-fg-muted">
                {present} / {data.staff}
              </span>
            </p>
            <div className="mt-3 flex h-3 w-full gap-[2px] overflow-hidden rounded-full" role="img" aria-label={`${t("dashboard.ops.attendance.chart")}: ${parts.map((p) => `${p.label} ${p.value}`).join(", ")}`}>
              {parts
                .filter((p) => p.value > 0)
                .map((p) => (
                  <span key={p.key} className="h-full first:rounded-s-full last:rounded-e-full" style={{ width: `${(p.value / total) * 100}%`, backgroundColor: p.color }} title={`${p.label}: ${p.value}`} />
                ))}
            </div>
            <ul className="mt-4 grid grid-cols-2 gap-x-4 gap-y-2 text-sm">
              {parts.map((p) => (
                <li key={p.key} className="flex items-center gap-2">
                  <span className="h-2.5 w-2.5 shrink-0 rounded-sm" style={{ backgroundColor: p.color }} aria-hidden />
                  <span className="truncate text-fg-muted">{p.label}</span>
                  <span className="ms-auto font-semibold tabular-nums text-fg">{p.value}</span>
                </li>
              ))}
            </ul>
          </>
        )}
      </div>
    </Card>
  );
}

/** Today's installations by stage, as labelled horizontal bars on one scale. */
export function ActivityCard({ data, t }: { data: NonNullable<OperationsOverview["activity"]>; t: T }) {
  const rows = [
    { key: "scheduled", label: t("dashboard.ops.activity.scheduled"), value: data.scheduled },
    { key: "inProgress", label: t("dashboard.ops.activity.inProgress"), value: data.inProgress },
    { key: "completed", label: t("dashboard.ops.activity.completed"), value: data.completed },
    { key: "issues", label: t("dashboard.ops.activity.issues"), value: data.issues },
  ];
  const max = Math.max(...rows.map((r) => r.value), 1);
  const total = rows.reduce((s, r) => s + r.value, 0);
  return (
    <Card className="flex flex-col">
      <CardHeader
        title={t("dashboard.ops.activity.title")}
        description={t("dashboard.ops.activity.description", { count: data.technicians })}
        icon={<Wrench className="h-4 w-4" />}
        actions={<HeaderLink href="/board">{t("dashboard.ops.activity.open")}</HeaderLink>}
      />
      <div className="flex-1 p-5">
        {total === 0 ? (
          <p className="py-6 text-center text-sm text-fg-muted">{t("dashboard.ops.activity.empty")}</p>
        ) : (
          <table className="w-full text-sm">
            <caption className="sr-only">{t("dashboard.ops.activity.title")}</caption>
            <tbody>
              {rows.map((r) => (
                <tr key={r.key}>
                  <th scope="row" className="w-[42%] py-1.5 pe-3 text-start font-normal text-fg-muted">
                    {r.label}
                  </th>
                  <td className="py-1.5">
                    <div className="flex items-center gap-2">
                      <div className="h-4 flex-1">
                        <div className="h-full rounded-e-[4px]" style={{ width: `${(r.value / max) * 100}%`, minWidth: r.value ? 4 : 0, backgroundColor: r.key === "issues" ? "var(--warning)" : "var(--series-1)" }} />
                      </div>
                      <span className="w-8 shrink-0 text-end font-semibold tabular-nums text-fg">{r.value}</span>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </Card>
  );
}

const APPROVAL_ICONS = { leaves: Plane, expenses: Receipt, evidence: ShieldCheck, stocktakes: ClipboardCheck, violations: Gavel } as const;

export function ApprovalsCard({ items, t }: { items: NonNullable<OperationsOverview["approvals"]>; t: T }) {
  const waiting = items.filter((i) => i.count > 0);
  return (
    <Card className="flex flex-col">
      <CardHeader title={t("dashboard.ops.approvals.title")} description={t("dashboard.ops.approvals.description")} icon={<Inbox className="h-4 w-4" />} />
      {waiting.length === 0 ? (
        <div className="flex flex-1 flex-col items-center justify-center gap-2 p-6 text-center">
          <CheckCircle2 className="h-6 w-6 text-success" aria-hidden />
          <p className="text-sm text-fg-muted">{t("dashboard.ops.approvals.none")}</p>
        </div>
      ) : (
        <ul className="flex-1 divide-y divide-line">
          {items.map((i) => {
            const Icon = APPROVAL_ICONS[i.key];
            return (
              <li key={i.key}>
                <Link href={i.href} className="group flex items-center gap-3 px-5 py-3 hover:bg-surface-muted">
                  <Icon className="h-4 w-4 shrink-0 text-fg-subtle" aria-hidden />
                  <span className="text-sm text-fg">{t(`dashboard.ops.approvals.${i.key}`)}</span>
                  <span
                    className={cn(
                      "ms-auto min-w-7 rounded-full px-2 py-0.5 text-center text-xs font-semibold tabular-nums",
                      i.count > 0 ? "bg-brand-strong text-white" : "bg-surface-muted text-fg-subtle",
                    )}
                  >
                    {i.count}
                  </span>
                  <ArrowRight className="h-3.5 w-3.5 text-fg-subtle opacity-0 transition-opacity group-hover:opacity-100 rtl:rotate-180" aria-hidden />
                </Link>
              </li>
            );
          })}
        </ul>
      )}
    </Card>
  );
}

export function SalesCard({ data, t }: { data: NonNullable<OperationsOverview["sales"]>; t: T }) {
  const { thisMonth, lastMonth } = data;
  const delta = lastMonth.total > 0 ? Math.round(((thisMonth.total - lastMonth.total) / lastMonth.total) * 100) : null;
  const months = data.monthly.map((m) => formatKey(m.month, { month: "short" }, t.locale));
  return (
    <Card className="flex flex-col">
      <CardHeader
        title={t("dashboard.ops.sales.title")}
        description={t("dashboard.ops.sales.description")}
        icon={<ShoppingCart className="h-4 w-4" />}
        actions={<HeaderLink href="/sales">{t("dashboard.ops.sales.open")}</HeaderLink>}
      />
      <div className="grid flex-1 gap-5 p-5 md:grid-cols-[minmax(0,13rem)_minmax(0,1fr)]">
        <div className="space-y-3">
          <div>
            <p className="text-xs font-medium uppercase tracking-wide text-fg-muted">{t("dashboard.ops.sales.thisMonth")}</p>
            <p className="mt-1 text-2xl font-semibold tabular-nums text-fg">{money(thisMonth.total, t.locale)}</p>
            <p className="text-xs text-fg-subtle">{t("dashboard.ops.sales.invoices", { count: thisMonth.count })}</p>
          </div>
          {delta !== null && (
            <p className={cn("inline-flex items-center gap-1 rounded-md px-2 py-1 text-xs font-medium", delta >= 0 ? "bg-success-soft text-success" : "bg-danger-soft text-danger")}>
              {delta >= 0 ? <TrendingUp className="h-3.5 w-3.5" aria-hidden /> : <TrendingDown className="h-3.5 w-3.5" aria-hidden />}
              <bdi dir="ltr">{`${delta >= 0 ? "+" : ""}${delta}%`}</bdi>
              <span className="sr-only">{t("dashboard.ops.sales.vsLast", { delta: `${delta}%` })}</span>
            </p>
          )}
          {data.drafts > 0 && (
            <p className="flex items-center gap-1.5 text-xs text-fg-muted">
              <FileText className="h-3.5 w-3.5" aria-hidden /> {t("dashboard.ops.sales.drafts", { count: data.drafts })}
            </p>
          )}
        </div>
        <MonthColumns
          title={t("dashboard.ops.sales.description")}
          months={months}
          series={[{ key: "sales", label: t("dashboard.ops.sales.title"), color: "var(--series-1)", values: data.monthly.map((m) => m.total) }]}
          emptyText={t("dashboard.ops.sales.empty")}
        />
      </div>
    </Card>
  );
}

export function WarehouseCard({ data, t }: { data: NonNullable<OperationsOverview["warehouse"]>; t: T }) {
  return (
    <Card>
      <CardHeader title={t("dashboard.ops.warehouse.title")} icon={<Warehouse className="h-4 w-4" />} actions={<HeaderLink href="/stock">{t("dashboard.ops.warehouse.open")}</HeaderLink>} />
      <div className="grid grid-cols-2 gap-3 p-5">
        <Figure label={t("dashboard.ops.warehouse.lowStock")} value={data.lowStock} icon={TriangleAlert} alert={data.lowStock > 0} />
        <Figure label={t("dashboard.ops.warehouse.outOfStock")} value={data.outOfStock} icon={PackageX} alert={data.outOfStock > 0} />
        <Figure label={t("dashboard.ops.warehouse.draftDocuments")} value={data.draftDocuments} icon={FileText} />
        <Figure label={t("dashboard.ops.warehouse.countingNow")} value={data.countingNow} icon={ClipboardCheck} />
      </div>
    </Card>
  );
}

export function FinanceCard({ data, t }: { data: NonNullable<OperationsOverview["finance"]>; t: T }) {
  return (
    <Card>
      <CardHeader title={t("dashboard.ops.finance.title")} icon={<Banknote className="h-4 w-4" />} actions={<HeaderLink href="/finance">{t("dashboard.ops.finance.open")}</HeaderLink>} />
      <div className="grid grid-cols-1 gap-3 p-5 sm:grid-cols-2">
        <Figure label={t("dashboard.ops.finance.cashHeld")} value={money(data.cashHeld, t.locale)} hint={t("dashboard.ops.finance.cashHeldHint", { count: data.cashHeldCount })} icon={Banknote} alert={data.cashHeld > 0} />
        <Figure label={t("dashboard.ops.finance.received")} value={money(data.receivedThisMonth, t.locale)} hint={t("dashboard.ops.finance.receivedHint")} icon={CheckCircle2} />
      </div>
    </Card>
  );
}
