import Link from "next/link";
import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { ClipboardCheck } from "lucide-react";
import { Card } from "@/components/ui/card";
import { EmptyState, PageHeader } from "@/components/ui/misc";
import { Pagination } from "@/components/ui/pagination";
import { StocktakeBadge } from "@/components/erp/badges";
import { NewStocktake } from "@/components/erp/stocktake-forms";
import { control, nameOf, submitBtn, tableHead, th, thEnd } from "@/components/erp/labels";
import { getT } from "@/i18n/server";
import { dateTime } from "@/lib/format";
import { STOCKTAKE_STATUSES } from "@/lib/inventory";
import { hasPermission } from "@/server/access";
import { requireUser } from "@/server/auth/session";
import { frozenWarehouseIds, listStocktakes } from "@/server/services/stocktakes";
import { warehouseOptions } from "@/server/services/inventory-warehouses";

export async function generateMetadata(): Promise<Metadata> {
  return { title: (await getT())("stocktakes.title") };
}

type SP = { status?: string; warehouseId?: string; page?: string };

export default async function StocktakesPage({ searchParams }: { searchParams: Promise<SP> }) {
  const [user, t] = await Promise.all([requireUser(), getT()]);
  if (!hasPermission(user, "inventory.count") && !hasPermission(user, "inventory.approve")) redirect("/access-denied");
  const sp = await searchParams;
  const canStart = hasPermission(user, "inventory.count");
  const [result, warehouses, open] = await Promise.all([
    listStocktakes(user, { status: sp.status, warehouseId: sp.warehouseId, page: Number(sp.page) || 1 }),
    warehouseOptions(user),
    frozenWarehouseIds(user),
  ]);
  const tz = user.settings.timezone;
  const L = t.locale;
  const qs = (page: number) => {
    const p = new URLSearchParams();
    for (const [k, v] of Object.entries(sp)) if (v && k !== "page") p.set(k, v);
    p.set("page", String(page));
    return `/stocktakes?${p}`;
  };
  return (
    <>
      <PageHeader title={t("stocktakes.title")} description={t("stocktakes.text")} />
      {canStart && warehouses.length > 0 && <NewStocktake warehouses={warehouses.map((w) => ({ id: w.id, code: w.code, nameEn: w.nameEn, nameAr: w.nameAr, frozen: open.has(w.id) }))} />}
      <Card className="mb-4 p-4">
        <form method="get" className="grid grid-cols-1 gap-3 sm:grid-cols-[12rem_12rem_auto]">
          <select name="status" defaultValue={sp.status ?? ""} aria-label={t("common.status")} className={control}>
            <option value="">{t("stocktakes.allStatuses")}</option>
            {STOCKTAKE_STATUSES.map((s) => (
              <option key={s} value={s}>
                {t.dyn(`enums.stocktakeStatus.${s}`)}
              </option>
            ))}
          </select>
          <select name="warehouseId" defaultValue={sp.warehouseId ?? ""} aria-label={t("stock.fields.warehouse")} className={control}>
            <option value="">{t("stock.allWarehouses")}</option>
            {warehouses.map((w) => (
              <option key={w.id} value={w.id}>
                {w.code}
              </option>
            ))}
          </select>
          <button type="submit" className={submitBtn}>
            {t("common.search")}
          </button>
        </form>
      </Card>
      <Card className="overflow-hidden">
        {result.rows.length === 0 ? (
          <EmptyState title={t("stocktakes.none")} description={t("stocktakes.noneText")} icon={<ClipboardCheck className="h-6 w-6" />} />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[620px] text-sm">
              <thead className={tableHead}>
                <tr>
                  <th className={th}>{t("stock.fields.number")}</th>
                  <th className={th}>{t("stock.fields.warehouse")}</th>
                  <th className={th}>{t("common.status")}</th>
                  <th className={th}>{t("common.date")}</th>
                  <th className={thEnd}>{t("stock.fields.lines")}</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-line">
                {result.rows.map((s) => (
                  <tr key={s.id} className="hover:bg-surface-muted/50">
                    <td className="px-4 py-2.5">
                      <Link href={`/stocktakes/${s.id}`} className="font-mono font-semibold text-brand-text hover:underline">
                        <bdi>{s.number}</bdi>
                      </Link>
                    </td>
                    <td className="px-4 py-2.5">
                      <bdi className="font-mono">{s.warehouse.code}</bdi> <span className="text-fg-muted">{nameOf(s.warehouse, t)}</span>
                    </td>
                    <td className="px-4 py-2.5">
                      <StocktakeBadge status={s.status} label={t.dyn(`enums.stocktakeStatus.${s.status}`)} />
                    </td>
                    <td className="whitespace-nowrap px-4 py-2.5 text-fg-muted">
                      {dateTime(s.createdAt, tz, L)} · {s.createdBy.name}
                    </td>
                    <td className="px-4 py-2.5 text-end tabular-nums">{s.lineCount}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {result.pageCount > 1 && <Pagination page={result.page} pageCount={result.pageCount} total={result.total} hrefFor={qs} />}
      </Card>
    </>
  );
}
