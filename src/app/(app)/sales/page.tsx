import Link from "next/link";
import type { Metadata } from "next";
import { Plus, ShoppingCart } from "lucide-react";
import { ButtonLink } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Badge, EmptyState, PageHeader } from "@/components/ui/misc";
import { Pagination } from "@/components/ui/pagination";
import { control, submitBtn, tableHead, th, thEnd } from "@/components/erp/labels";
import { saleStatusTone as statusTone } from "@/components/sales/labels";
import { getT } from "@/i18n/server";
import { money } from "@/lib/constants";
import { SALES_STATUSES } from "@/lib/sales";
import { formatKey } from "@/lib/time";
import { hasPermission } from "@/server/access";
import { requirePagePermission } from "@/server/auth/session";
import { listSales } from "@/server/services/sales";

export async function generateMetadata(): Promise<Metadata> {
  return { title: (await getT())("sales.title") };
}

type SP = { q?: string; status?: string; from?: string; to?: string; page?: string };

export default async function SalesPage({ searchParams }: { searchParams: Promise<SP> }) {
  const [user, t] = await Promise.all([requirePagePermission("sales.view"), getT()]);
  const sp = await searchParams;
  const result = await listSales(user, { q: sp.q, status: sp.status, from: sp.from, to: sp.to, page: Number(sp.page) || 1 });
  const L = t.locale;
  const qs = (page: number) => {
    const p = new URLSearchParams();
    for (const [k, v] of Object.entries(sp)) if (v && k !== "page") p.set(k, v);
    p.set("page", String(page));
    return `/sales?${p}`;
  };
  return (
    <>
      <PageHeader
        title={t("sales.title")}
        description={t("sales.text")}
        actions={
          hasPermission(user, "sales.manage") && (
            <ButtonLink href="/sales/new">
              <Plus className="h-4 w-4" /> {t("sales.new")}
            </ButtonLink>
          )
        }
      />
      <Card className="mb-4 p-4">
        <form method="get" className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-[1fr_10rem_10rem_10rem_auto]">
          <input name="q" defaultValue={sp.q} placeholder={t("sales.search")} aria-label={t("sales.search")} className={control} />
          <select name="status" defaultValue={sp.status ?? ""} aria-label={t("common.status")} className={control}>
            <option value="">{t("sales.allStatuses")}</option>
            {SALES_STATUSES.map((s) => (
              <option key={s} value={s}>
                {t(`sales.statuses.${s}`)}
              </option>
            ))}
          </select>
          <input type="date" name="from" defaultValue={sp.from} aria-label={t("analytics.from")} className={control} />
          <input type="date" name="to" defaultValue={sp.to} aria-label={t("analytics.to")} className={control} />
          <button type="submit" className={submitBtn}>
            {t("common.search")}
          </button>
        </form>
      </Card>
      <Card className="overflow-hidden">
        {result.rows.length === 0 ? (
          <EmptyState title={sp.q || sp.status ? t("sales.noMatch") : t("sales.none")} icon={<ShoppingCart className="h-6 w-6" />} />
        ) : (
          <>
            <p className="border-b border-line px-4 py-2 text-xs text-fg-muted">{t("sales.confirmedTotal", { count: result.confirmedCount, total: money(result.confirmedTotal, L) })}</p>
            <div className="overflow-x-auto">
              <table className="w-full min-w-[640px] text-sm">
                <thead className={tableHead}>
                  <tr>
                    <th className={th}>{t("sales.number")}</th>
                    <th className={th}>{t("sales.date")}</th>
                    <th className={th}>{t("sales.customer")}</th>
                    <th className={th}>{t("stock.fields.warehouse")}</th>
                    <th className={th}>{t("common.status")}</th>
                    <th className={thEnd}>{t("sales.total")}</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-line">
                  {result.rows.map((r) => (
                    <tr key={r.id} className="hover:bg-surface-muted/50">
                      <td className="px-4 py-2.5">
                        <Link prefetch={false} href={`/sales/${r.id}`} className="font-mono font-semibold text-brand-text hover:underline">
                          {r.number}
                        </Link>
                      </td>
                      <td className="whitespace-nowrap px-4 py-2.5 text-fg-muted">{formatKey(r.invoiceDate, { day: "numeric", month: "short", year: "numeric" }, L)}</td>
                      <td className="px-4 py-2.5" dir="auto">
                        {r.customerName}
                      </td>
                      <td className="px-4 py-2.5 font-mono text-fg-muted">{r.warehouse.code}</td>
                      <td className="px-4 py-2.5">
                        <Badge className={statusTone[r.status]}>{t(`sales.statuses.${r.status}`)}</Badge>
                      </td>
                      <td className="px-4 py-2.5 text-end tabular-nums">{money(r.total, L)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        )}
        {result.pageCount > 1 && <Pagination page={result.page} pageCount={result.pageCount} total={result.total} hrefFor={qs} />}
      </Card>
    </>
  );
}
