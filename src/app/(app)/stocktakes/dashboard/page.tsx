import Link from "next/link";
import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { Card, CardHeader } from "@/components/ui/card";
import { BackArrow, PageHeader } from "@/components/ui/misc";
import { StocktakeBadge } from "@/components/erp/badges";
import { control, nameOf, submitBtn, tableHead, th, thEnd } from "@/components/erp/labels";
import { getT } from "@/i18n/server";
import { dateTime } from "@/lib/format";
import { STOCKTAKE_STATUSES, formatQuantity } from "@/lib/inventory";
import { hasPermission } from "@/server/access";
import { requireUser } from "@/server/auth/session";
import { prisma } from "@/server/db";
import { catalogOptions } from "@/server/services/inventory-catalog";
import { warehouseOptions } from "@/server/services/inventory-warehouses";
import { stocktakeDashboard, type StocktakeDashboard } from "@/server/services/stocktake-dashboard";

export async function generateMetadata(): Promise<Metadata> {
  return { title: (await getT())("stocktakePlan.dashboard") };
}

type SP = { warehouseId?: string; userId?: string; categoryId?: string; from?: string; to?: string; status?: string; month?: string };
type Session = StocktakeDashboard["today"][number];

export default async function StocktakeDashboardPage({ searchParams }: { searchParams: Promise<SP> }) {
  const [user, t] = await Promise.all([requireUser(), getT()]);
  if (!hasPermission(user, "inventory.count") && !hasPermission(user, "inventory.approve") && !hasPermission(user, "stocktakes.schedule")) redirect("/access-denied");
  const sp = await searchParams;
  const [d, warehouses, catalog, people] = await Promise.all([
    stocktakeDashboard(user, sp),
    warehouseOptions(user),
    catalogOptions(user),
    prisma.user.findMany({ where: { isActive: true, role: { in: ["ADMIN", "STORE", "WAREHOUSE_MANAGER"] } }, select: { id: true, name: true }, orderBy: { name: "asc" } }),
  ]);
  const tz = user.settings.timezone;
  const L = t.locale;
  const q = (patch: Partial<SP>) => {
    const p = new URLSearchParams();
    for (const [k, v] of Object.entries({ ...sp, ...patch })) if (v) p.set(k, v);
    return `/stocktakes/dashboard?${p}`;
  };
  const list = (title: string, rows: Session[], tone?: "danger" | "warning") => (
    <Card className="overflow-hidden" data-section={title}>
      <CardHeader title={`${title} (${rows.length})`} />
      {rows.length === 0 ? (
        <p className="px-5 pb-5 text-sm text-fg-muted">{t("stocktakePlan.none")}</p>
      ) : (
        <ul className="divide-y divide-line">
          {rows.slice(0, 15).map((s) => (
            <li key={s.id} className={tone === "danger" ? "bg-danger-soft/30" : tone === "warning" ? "bg-warning-soft/30" : undefined}>
              <Link prefetch={false} href={`/stocktakes/${s.id}`} className="flex flex-wrap items-center justify-between gap-2 px-5 py-2.5 text-sm hover:bg-surface-muted/50">
                <span className="min-w-0">
                  <bdi className="font-mono font-semibold text-brand-text">{s.number}</bdi> <span dir="auto">{s.name ?? ""}</span>
                  <span className="block text-xs text-fg-muted">
                    <bdi className="font-mono">{s.warehouse.code}</bdi> · {s.plannedStart ? dateTime(s.plannedStart, tz, L) : s.day}
                  </span>
                </span>
                <span className="flex items-center gap-1">
                  <StocktakeBadge status={s.status} label={t.dyn(`enums.stocktakeStatus.${s.status}`)} />
                  {s.overdue && <span className="rounded-full border border-danger/40 bg-danger-soft px-2 py-0.5 text-xs font-medium">{t("stocktakePlan.overdueBadge")}</span>}
                </span>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
  // Month grid (weeks as rows), from the 1st of the month.
  const [y, m] = d.month.split("-").map(Number) as [number, number];
  const first = new Date(Date.UTC(y, m - 1, 1));
  const days = new Date(Date.UTC(y, m, 0)).getUTCDate();
  const lead = (first.getUTCDay() - user.settings.weekStartsOn + 7) % 7;
  const cells = [...Array.from({ length: lead }, () => null), ...Array.from({ length: days }, (_, i) => `${d.month}-${String(i + 1).padStart(2, "0")}`)];
  const prevMonth = new Date(Date.UTC(y, m - 2, 1)).toISOString().slice(0, 7);
  const nextMonth = new Date(Date.UTC(y, m, 1)).toISOString().slice(0, 7);
  return (
    <>
      <PageHeader
        breadcrumb={
          <Link href="/stocktakes" className="hover:text-fg">
            <BackArrow /> {t("stocktakes.backToList")}
          </Link>
        }
        title={t("stocktakePlan.dashboard")}
        description={t("stocktakePlan.dashboardText")}
      />
      <Card className="mb-6 p-4">
        <form method="get" className="grid grid-cols-1 gap-3 sm:grid-cols-3 lg:grid-cols-7">
          <select name="warehouseId" defaultValue={sp.warehouseId ?? ""} aria-label={t("stocktakePlan.filters.warehouse")} className={control}>
            <option value="">{t("stock.allWarehouses")}</option>
            {warehouses.map((w) => (
              <option key={w.id} value={w.id}>
                {w.code}
              </option>
            ))}
          </select>
          <select name="userId" defaultValue={sp.userId ?? ""} aria-label={t("stocktakePlan.filters.employee")} className={control}>
            <option value="">{t("stocktakePlan.filters.employee")}</option>
            {people.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
          <select name="categoryId" defaultValue={sp.categoryId ?? ""} aria-label={t("stocktakePlan.filters.category")} className={control}>
            <option value="">{t("stocktakePlan.filters.category")}</option>
            {catalog.categories.map((c) => (
              <option key={c.id} value={c.id}>
                {nameOf(c, t)}
              </option>
            ))}
          </select>
          <select name="status" defaultValue={sp.status ?? ""} aria-label={t("stocktakePlan.filters.status")} className={control}>
            <option value="">{t("stocktakes.allStatuses")}</option>
            {STOCKTAKE_STATUSES.map((s) => (
              <option key={s} value={s}>
                {t.dyn(`enums.stocktakeStatus.${s}`)}
              </option>
            ))}
          </select>
          <input type="date" name="from" defaultValue={sp.from ?? d.from} aria-label={t("stocktakePlan.filters.from")} className={control} />
          <input type="date" name="to" defaultValue={sp.to ?? d.to} aria-label={t("stocktakePlan.filters.to")} className={control} />
          <button type="submit" className={submitBtn}>
            {t("stocktakePlan.filters.apply")}
          </button>
        </form>
      </Card>

      <div className="mb-6 grid grid-cols-1 gap-6 lg:grid-cols-2">
        {list(t("stocktakePlan.today"), d.today)}
        {list(t("stocktakePlan.overdue"), d.overdue, "danger")}
        {list(t("stocktakePlan.pendingApproval"), d.pendingApproval, "warning")}
        {list(t("stocktakePlan.upcoming"), d.upcoming)}
        {list(t("stocktakePlan.active"), d.active)}
        {list(t("stocktakePlan.completed"), d.completed)}
      </div>

      <Card className="mb-6 overflow-hidden">
        <CardHeader
          title={`${t("stocktakePlan.calendarMonth")}: ${d.month}`}
          actions={
            <span className="flex gap-2 text-sm">
              <Link href={q({ month: prevMonth })} className="text-brand-text hover:underline" aria-label={prevMonth}>
                {"←"} <bdi>{prevMonth}</bdi>
              </Link>
              <Link href={q({ month: nextMonth })} className="text-brand-text hover:underline" aria-label={nextMonth}>
                <bdi>{nextMonth}</bdi> {"→"}
              </Link>
            </span>
          }
        />
        <div className="grid grid-cols-7 gap-px bg-line p-px text-xs" role="grid" aria-label={t("stocktakePlan.calendarMonth")}>
          {cells.map((day, i) => (
            <div key={i} className="min-h-16 bg-surface p-1.5" role="gridcell">
              {day && (
                <>
                  <span className="font-medium tabular-nums text-fg-muted">{Number(day.slice(8))}</span>
                  {(d.calendar[day] ?? []).slice(0, 3).map((s) => (
                    <Link key={s.id} prefetch={false} href={`/stocktakes/${s.id}`} className={`mt-0.5 block truncate rounded px-1 ${s.overdue ? "bg-danger-soft" : s.status === "APPROVED" ? "bg-success-soft" : "bg-surface-muted"}`} title={s.name ?? s.number}>
                      <bdi className="font-mono">{s.warehouse.code}</bdi> <span dir="auto">{s.name ?? s.number}</span>
                    </Link>
                  ))}
                  {(d.calendar[day]?.length ?? 0) > 3 && <span className="text-fg-subtle">+{(d.calendar[day]?.length ?? 0) - 3}</span>}
                </>
              )}
            </div>
          ))}
        </div>
      </Card>

      <div className="mb-6 grid grid-cols-1 gap-6 xl:grid-cols-2">
        <Card className="overflow-hidden">
          <CardHeader title={`${t("stocktakePlan.calendarYear")}: ${d.year}`} />
          <div className="overflow-x-auto">
            <table className="w-full min-w-[420px] text-sm">
              <thead className={tableHead}>
                <tr>
                  <th className={th}>{t("stocktakePlan.calendarMonth")}</th>
                  <th className={thEnd}>{t("stocktakePlan.cols.total")}</th>
                  <th className={thEnd}>{t("stocktakePlan.cols.completed")}</th>
                  <th className={thEnd}>{t("enums.stocktakeStatus.PLANNED")}</th>
                  <th className={thEnd}>{t("stocktakePlan.cols.overdue")}</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-line">
                {d.yearly.map((r) => (
                  <tr key={r.month}>
                    <td className="px-4 py-2">
                      <Link href={q({ month: r.month })} className="text-brand-text hover:underline">
                        <bdi>{r.month}</bdi>
                      </Link>
                    </td>
                    <td className="px-4 py-2 text-end tabular-nums">{r.total}</td>
                    <td className="px-4 py-2 text-end tabular-nums">{r.approved}</td>
                    <td className="px-4 py-2 text-end tabular-nums">{r.planned}</td>
                    <td className={`px-4 py-2 text-end tabular-nums ${r.overdue ? "font-medium text-danger" : ""}`}>{r.overdue}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
        <Card className="overflow-hidden">
          <CardHeader title={t("stocktakePlan.performance")} />
          <div className="overflow-x-auto">
            <table className="w-full min-w-[480px] text-sm">
              <thead className={tableHead}>
                <tr>
                  <th className={th}>{t("stocktakePlan.cols.warehouse")}</th>
                  <th className={thEnd}>{t("stocktakePlan.cols.completed")}</th>
                  <th className={thEnd}>{t("stocktakePlan.cols.onTime")}</th>
                  <th className={thEnd}>{t("stocktakePlan.cols.late")}</th>
                  <th className={thEnd}>{t("stocktakePlan.cols.overdue")}</th>
                  <th className={thEnd}>{t("stocktakePlan.cols.accuracy")}</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-line">
                {d.warehouses.map((w) => (
                  <tr key={w.warehouse.id}>
                    <td className="px-4 py-2">
                      <bdi className="font-mono">{w.warehouse.code}</bdi> <span className="text-fg-muted">{nameOf(w.warehouse, t)}</span>
                    </td>
                    <td className="px-4 py-2 text-end tabular-nums">{w.completed}</td>
                    <td className="px-4 py-2 text-end tabular-nums">{w.onTime}</td>
                    <td className="px-4 py-2 text-end tabular-nums">{w.late}</td>
                    <td className="px-4 py-2 text-end tabular-nums">{w.overdue}</td>
                    <td className="px-4 py-2 text-end tabular-nums">{w.accuracy === null ? "—" : `${w.accuracy}%`}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      </div>

      <div className="grid grid-cols-1 gap-6 xl:grid-cols-2">
        <Card className="overflow-hidden">
          <CardHeader title={`${t("stocktakePlan.discrepancies")} (${d.discrepancies.length})`} />
          <div className="overflow-x-auto">
            <table className="w-full min-w-[560px] text-sm">
              <thead className={tableHead}>
                <tr>
                  <th className={th}>{t("stocktakePlan.cols.session")}</th>
                  <th className={th}>{t("stocktakePlan.cols.product")}</th>
                  <th className={thEnd}>{t("stocktakePlan.cols.system")}</th>
                  <th className={thEnd}>{t("stocktakePlan.cols.counted")}</th>
                  <th className={thEnd}>{t("stocktakePlan.cols.difference")}</th>
                  <th className={thEnd}>{t("stocktakePlan.cols.damaged")}</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-line">
                {d.discrepancies.map((x, i) => (
                  <tr key={i}>
                    <td className="px-4 py-2">
                      <Link prefetch={false} href={`/stocktakes/${x.stocktakeId}`} className="font-mono text-brand-text hover:underline">
                        <bdi>{x.number}</bdi>
                      </Link>
                      <span className="block text-xs text-fg-muted">
                        <bdi>{x.warehouse}</bdi>
                      </span>
                    </td>
                    <td className="px-4 py-2">
                      <bdi className="font-mono">{x.product.sku}</bdi> {nameOf(x.product, t)}
                    </td>
                    <td className="px-4 py-2 text-end tabular-nums">{formatQuantity(x.system, L)}</td>
                    <td className="px-4 py-2 text-end tabular-nums">{formatQuantity(x.counted, L)}</td>
                    <td className={`px-4 py-2 text-end font-medium tabular-nums ${x.difference < 0 ? "text-danger" : x.difference > 0 ? "text-success" : ""}`}>{x.difference > 0 ? `+${formatQuantity(x.difference, L)}` : formatQuantity(x.difference, L)}</td>
                    <td className="px-4 py-2 text-end tabular-nums">{x.damaged ? formatQuantity(x.damaged, L) : "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
        <Card className="overflow-hidden">
          <CardHeader title={`${t("stocktakePlan.repeated")} (${d.repeated.length})`} />
          {d.repeated.length === 0 ? (
            <p className="px-5 pb-5 text-sm text-fg-muted">{t("stocktakePlan.none")}</p>
          ) : (
            <table className="w-full text-sm">
              <thead className={tableHead}>
                <tr>
                  <th className={th}>{t("stocktakePlan.cols.product")}</th>
                  <th className={thEnd}>{t("stocktakePlan.cols.sessions")}</th>
                  <th className={thEnd}>{t("stocktakePlan.cols.net")}</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-line">
                {d.repeated.map((r) => (
                  <tr key={r.product.id}>
                    <td className="px-4 py-2">
                      <bdi className="font-mono">{r.product.sku}</bdi> {nameOf(r.product, t)}
                    </td>
                    <td className="px-4 py-2 text-end tabular-nums">{r.sessions}</td>
                    <td className={`px-4 py-2 text-end tabular-nums ${r.net < 0 ? "text-danger" : "text-success"}`}>{r.net > 0 ? `+${formatQuantity(r.net, L)}` : formatQuantity(r.net, L)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Card>
      </div>
    </>
  );
}
