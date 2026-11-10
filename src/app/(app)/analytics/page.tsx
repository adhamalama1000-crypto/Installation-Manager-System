import Link from "next/link";
import type { Metadata } from "next";
import { Card, CardHeader } from "@/components/ui/card";
import { Alert, PageHeader } from "@/components/ui/misc";
import { BarList, StatTile } from "@/components/reports/charts";
import { MonthColumns } from "@/components/sales/month-columns";
import { control, nameOf, submitBtn, tableHead, th, thEnd } from "@/components/erp/labels";
import { getT } from "@/i18n/server";
import { intlLocale } from "@/i18n/config";
import { money } from "@/lib/constants";
import { formatQuantity } from "@/lib/inventory";
import { formatKey } from "@/lib/time";
import { requirePagePermission } from "@/server/auth/session";
import { prisma } from "@/server/db";
import { salesAnalytics } from "@/server/services/sales-analytics";

export async function generateMetadata(): Promise<Metadata> {
  return { title: (await getT())("analytics.title") };
}

type SP = { from?: string; to?: string; year?: string; month?: string; categoryId?: string; brandId?: string; warehouseId?: string; productId?: string; rollUp?: string };

/** A year (and optional month) picked from the quick selector becomes a date range. */
function rangeOf(sp: SP): { from?: string; to?: string } {
  if (sp.year && /^\d{4}$/.test(sp.year)) {
    if (sp.month && /^(0?[1-9]|1[0-2])$/.test(sp.month)) {
      const m = sp.month.padStart(2, "0");
      const last = new Date(Date.UTC(Number(sp.year), Number(m), 0)).getUTCDate();
      return { from: `${sp.year}-${m}-01`, to: `${sp.year}-${m}-${String(last).padStart(2, "0")}` };
    }
    return { from: `${sp.year}-01-01`, to: `${sp.year}-12-31` };
  }
  return { from: sp.from, to: sp.to };
}

export default async function AnalyticsPage({ searchParams }: { searchParams: Promise<SP> }) {
  const [user, t] = await Promise.all([requirePagePermission("analytics.view"), getT()]);
  const sp = await searchParams;
  const range = rangeOf(sp);
  const [a, categories, brands, warehouses] = await Promise.all([
    salesAnalytics(user, { ...range, categoryId: sp.categoryId || undefined, brandId: sp.brandId || undefined, warehouseId: sp.warehouseId || undefined, productId: sp.productId || undefined, rollUp: sp.rollUp !== "0" }),
    prisma.catalogCategory.findMany({ where: { parentId: null }, orderBy: { nameEn: "asc" }, select: { id: true, nameEn: true, nameAr: true } }),
    prisma.brand.findMany({ orderBy: { name: "asc" }, select: { id: true, name: true } }),
    prisma.warehouse.findMany({ where: { isActive: true }, orderBy: { code: "asc" }, select: { id: true, code: true, nameEn: true, nameAr: true } }),
  ]);
  const L = t.locale;
  const m = (n: number | null) => (n === null ? "—" : money(n, L));
  const day = (k: string | null) => (k ? formatKey(k, { day: "numeric", month: "short", year: "numeric" }, L) : t("analytics.never"));
  const monthName = (i: number) => new Intl.DateTimeFormat(intlLocale(L), { month: "short", timeZone: "UTC" }).format(new Date(Date.UTC(2026, i, 1)));
  // Every month of the range, also those without sales.
  const months: string[] = [];
  for (let d = new Date(`${a.from.slice(0, 7)}-01T00:00:00Z`); d.toISOString().slice(0, 7) <= a.to.slice(0, 7); d.setUTCMonth(d.getUTCMonth() + 1)) months.push(d.toISOString().slice(0, 7));
  const monthLabel = (k: string) => (months.length > 12 ? `${monthName(Number(k.slice(5)) - 1)} ${k.slice(2, 4)}` : monthName(Number(k.slice(5)) - 1));
  const currentYear = Number(a.to.slice(0, 4));
  const years = Array.from({ length: 5 }, (_, i) => currentYear - i);
  const productTable = (rows: typeof a.best, empty: string) =>
    rows.length === 0 ? (
      <p className="px-5 py-6 text-center text-sm text-fg-muted">{empty}</p>
    ) : (
      <div className="overflow-x-auto">
        <table className="w-full min-w-[520px] text-sm">
          <thead className={tableHead}>
            <tr>
              <th className={th}>{t("stock.fields.product")}</th>
              <th className={thEnd}>{t("analytics.quantity")}</th>
              <th className={thEnd}>{t("analytics.revenue")}</th>
              {a.showCosts && <th className={thEnd}>{t("sales.margin")}</th>}
              <th className={th}>{t("analytics.lastSold")}</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-line">
            {rows.map((r) => (
              <tr key={r.id}>
                <td className="px-4 py-2">
                  <Link prefetch={false} href={`/products/${r.id}`} className="font-mono font-semibold text-brand-text hover:underline">
                    {r.sku}
                  </Link>{" "}
                  {nameOf(r, t)}
                </td>
                <td className="px-4 py-2 text-end tabular-nums">
                  {formatQuantity(r.qty, L)} <span className="text-xs text-fg-subtle">{r.unit}</span>
                </td>
                <td className="px-4 py-2 text-end tabular-nums">{m(r.revenue)}</td>
                {a.showCosts && <td className="px-4 py-2 text-end tabular-nums">{m(r.margin)}</td>}
                <td className="px-4 py-2 text-fg-muted">{day(r.lastSold)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    );
  return (
    <>
      <PageHeader title={t("analytics.title")} description={t("analytics.text")} />
      <Card className="mb-6 p-4">
        <form method="get" className="grid grid-cols-2 gap-3 md:grid-cols-4 xl:grid-cols-[8rem_8rem_9rem_9rem_1fr_1fr_1fr_auto]">
          <select name="year" defaultValue={sp.year ?? ""} aria-label={t("analytics.year")} className={control}>
            <option value="">{t("analytics.period")}</option>
            {years.map((y) => (
              <option key={y} value={y}>
                {y}
              </option>
            ))}
          </select>
          <select name="month" defaultValue={sp.month ?? ""} aria-label={t("analytics.month")} className={control}>
            <option value="">{t("analytics.wholeYear")}</option>
            {Array.from({ length: 12 }, (_, i) => (
              <option key={i} value={i + 1}>
                {monthName(i)}
              </option>
            ))}
          </select>
          <input type="date" name="from" defaultValue={sp.year ? "" : (sp.from ?? "")} aria-label={t("analytics.from")} className={control} />
          <input type="date" name="to" defaultValue={sp.year ? "" : (sp.to ?? "")} aria-label={t("analytics.to")} className={control} />
          <select name="categoryId" defaultValue={sp.categoryId ?? ""} aria-label={t("analytics.category")} className={control}>
            <option value="">{t("analytics.allCategories")}</option>
            {categories.map((c) => (
              <option key={c.id} value={c.id}>
                {nameOf(c, t)}
              </option>
            ))}
          </select>
          <select name="brandId" defaultValue={sp.brandId ?? ""} aria-label={t("analytics.brand")} className={control}>
            <option value="">{t("analytics.allBrands")}</option>
            {brands.map((b) => (
              <option key={b.id} value={b.id}>
                {b.name}
              </option>
            ))}
          </select>
          <select name="warehouseId" defaultValue={sp.warehouseId ?? ""} aria-label={t("analytics.warehouse")} className={control}>
            <option value="">{t("analytics.allWarehouses")}</option>
            {warehouses.map((w) => (
              <option key={w.id} value={w.id}>
                {w.code} · {nameOf(w, t)}
              </option>
            ))}
          </select>
          <button type="submit" className={submitBtn}>
            {t("analytics.apply")}
          </button>
          <label className="col-span-2 flex items-center gap-2 text-sm text-fg-muted md:col-span-4 xl:col-span-8">
            <input type="checkbox" name="rollUp" value="0" defaultChecked={sp.rollUp === "0"} className="h-4 w-4 accent-[var(--brand-strong)]" />
            {t("analytics.rollUp")}: {t("common.no")}
          </label>
        </form>
        <p className="mt-2 text-xs text-fg-subtle">
          {day(a.from)} – {day(a.to)}
        </p>
      </Card>

      <div className="mb-6 grid grid-cols-2 gap-3 lg:grid-cols-4">
        <StatTile label={t("analytics.revenue")} value={m(a.totals.revenue)} sub={t("analytics.invoices") + `: ${a.totals.invoices}`} />
        <StatTile label={t("analytics.quantity")} value={formatQuantity(a.totals.qty, L)} sub={`${t("analytics.avgInvoice")}: ${m(a.totals.avgInvoice)}`} />
        {a.showCosts && <StatTile label={t("analytics.grossMargin")} value={m(a.totals.grossMargin)} sub={a.totals.marginPct === null ? undefined : `${a.totals.marginPct}% · ${t("analytics.cogs")}: ${m(a.totals.cogs)}`} />}
        {a.showCosts && <StatTile label={t("analytics.stockValue")} value={m(a.totals.stockValue)} sub={a.totals.turnover === null ? undefined : `${t("analytics.turnover")}: ${a.totals.turnover}×`} />}
      </div>

      {a.totals.invoices === 0 && <Alert className="mb-6">{t("analytics.noData")}</Alert>}

      <div className="mb-6 grid grid-cols-1 gap-6 xl:grid-cols-2">
        <Card>
          <CardHeader title={t("analytics.monthly")} />
          <div className="p-5">
            <MonthColumns
              title={t("analytics.monthly")}
              months={months.map(monthLabel)}
              series={[{ key: "revenue", label: t("analytics.revenue"), color: "var(--series-1)", values: months.map((k) => a.monthly.find((x) => x.month === k)?.revenue ?? 0) }]}
              emptyText={t("analytics.noData")}
            />
          </div>
        </Card>
        <Card>
          <CardHeader title={t("analytics.yearly")} description={`${a.yearly.year} / ${a.yearly.year - 1}`} />
          <div className="p-5">
            <MonthColumns
              title={t("analytics.yearly")}
              months={Array.from({ length: 12 }, (_, i) => monthName(i))}
              series={[
                { key: "this", label: `${t("analytics.thisYear")} (${a.yearly.year})`, color: "var(--series-1)", values: a.yearly.thisYear },
                { key: "last", label: `${t("analytics.lastYear")} (${a.yearly.year - 1})`, color: "var(--series-2)", values: a.yearly.lastYear },
              ]}
              emptyText={t("analytics.noData")}
            />
          </div>
        </Card>
      </div>

      <div className="mb-6 grid grid-cols-1 gap-6 xl:grid-cols-2">
        <Card>
          <CardHeader title={t("analytics.byCategory")} />
          <div className="px-5 pb-5">
            <BarList rows={a.byCategory.map((c) => ({ key: c.id ?? "none", label: c.nameEn ? nameOf({ nameEn: c.nameEn, nameAr: c.nameAr ?? c.nameEn }, t) : t("analytics.uncategorised"), value: c.revenue, display: money(c.revenue, L) }))} emptyText={t("analytics.noData")} />
          </div>
        </Card>
        <Card>
          <CardHeader title={t("analytics.byBrand")} />
          <div className="px-5 pb-5">
            <BarList rows={a.byBrand.map((b) => ({ key: b.id ?? "none", label: b.name ?? t("analytics.noBrand"), value: b.revenue, display: money(b.revenue, L) }))} emptyText={t("analytics.noData")} />
          </div>
        </Card>
      </div>

      <div className="mb-6 grid grid-cols-1 gap-6 xl:grid-cols-2">
        <Card className="overflow-hidden">
          <CardHeader title={t("analytics.best")} description={t("analytics.byQuantity")} />
          {productTable(a.best, t("analytics.noData"))}
        </Card>
        <Card className="overflow-hidden">
          <CardHeader title={t("analytics.lowest")} description={t("analytics.byQuantity")} />
          {productTable(a.lowest, t("analytics.noData"))}
        </Card>
      </div>

      <div className="mb-6 grid grid-cols-1 gap-6 xl:grid-cols-2">
        <Card className="overflow-hidden">
          <CardHeader title={`${t("analytics.noSales")} (${a.noSales.total})`} description={t("analytics.noSalesHint")} />
          <StockTable rows={a.noSales.rows.map((r) => ({ ...r, extra: null }))} showValue={a.showCosts} t={t} L={L} empty={t("common.none")} />
        </Card>
        <Card className="overflow-hidden">
          <CardHeader title={`${t("analytics.slowMoving")} (${a.slowMoving.total})`} description={t("analytics.slowMovingHint", { days: a.slowDays })} />
          <StockTable rows={a.slowMoving.rows.map((r) => ({ ...r, extra: day(r.lastSold) }))} extraLabel={t("analytics.lastSold")} showValue={a.showCosts} t={t} L={L} empty={t("common.none")} />
        </Card>
      </div>

      <div className="mb-6 grid grid-cols-1 gap-6 xl:grid-cols-2">
        <Card className="overflow-hidden">
          <CardHeader title={`${t("analytics.lowStock")} (${a.lowStock.total})`} description={t("analytics.lowStockHint")} />
          <StockTable rows={a.lowStock.rows.map((r) => ({ ...r, value: null, extra: `${formatQuantity(r.minStock, L)} ${r.unit}` }))} extraLabel={t("analytics.minimum")} showValue={false} t={t} L={L} empty={t("common.none")} />
        </Card>
        {a.showCosts && (
          <Card className="overflow-hidden">
            <CardHeader title={t("analytics.turnover")} description={t("analytics.turnoverHint")} />
            {a.turnover.length === 0 ? (
              <p className="px-5 py-6 text-center text-sm text-fg-muted">{t("analytics.noData")}</p>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full min-w-[480px] text-sm">
                  <thead className={tableHead}>
                    <tr>
                      <th className={th}>{t("stock.fields.product")}</th>
                      <th className={thEnd}>{t("analytics.cogs")}</th>
                      <th className={thEnd}>{t("analytics.turnover")}</th>
                      <th className={thEnd}>{t("analytics.daysOfCover")}</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-line">
                    {a.turnover.map((r) => (
                      <tr key={r.id}>
                        <td className="px-4 py-2">
                          <bdi className="font-mono font-semibold">{r.sku}</bdi> {nameOf(r, t)}
                        </td>
                        <td className="px-4 py-2 text-end tabular-nums">{m(r.cost)}</td>
                        <td className="px-4 py-2 text-end tabular-nums">{r.turnover}×</td>
                        <td className="px-4 py-2 text-end tabular-nums">{r.daysOfCover ?? "—"}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </Card>
        )}
      </div>

      {a.showCosts && a.valuation.length > 0 && (
        <Card className="overflow-hidden">
          <CardHeader title={t("analytics.stockValue")} />
          <div className="px-5 pb-5">
            <BarList rows={a.valuation.map((w) => ({ key: w.id, label: `${w.code} · ${nameOf(w, t)}`, value: w.value, display: money(w.value, L) }))} emptyText={t("common.none")} />
          </div>
        </Card>
      )}
    </>
  );
}

function StockTable({
  rows,
  showValue,
  extraLabel,
  t,
  L,
  empty,
}: {
  rows: { id: string; sku: string; nameEn: string; nameAr: string; unit: string; onHand: number; value: number | null; extra: string | null }[];
  showValue: boolean;
  extraLabel?: string;
  t: Awaited<ReturnType<typeof getT>>;
  L: "ar" | "en";
  empty: string;
}) {
  if (!rows.length) return <p className="px-5 py-6 text-center text-sm text-fg-muted">{empty}</p>;
  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[480px] text-sm">
        <thead className={tableHead}>
          <tr>
            <th className={th}>{t("stock.fields.product")}</th>
            <th className={thEnd}>{t("analytics.onHand")}</th>
            {showValue && <th className={thEnd}>{t("analytics.value")}</th>}
            {extraLabel && <th className={th}>{extraLabel}</th>}
          </tr>
        </thead>
        <tbody className="divide-y divide-line">
          {rows.map((r) => (
            <tr key={r.id}>
              <td className="px-4 py-2">
                <Link prefetch={false} href={`/products/${r.id}`} className="font-mono font-semibold text-brand-text hover:underline">
                  {r.sku}
                </Link>{" "}
                {nameOf(r, t)}
              </td>
              <td className="px-4 py-2 text-end tabular-nums">
                {formatQuantity(r.onHand, L)} <span className="text-xs text-fg-subtle">{r.unit}</span>
              </td>
              {showValue && <td className="px-4 py-2 text-end tabular-nums">{r.value === null ? "—" : money(r.value, L)}</td>}
              {extraLabel && <td className="px-4 py-2 text-fg-muted">{r.extra}</td>}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
