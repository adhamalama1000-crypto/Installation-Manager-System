import Link from "next/link";
import type { Metadata } from "next";
import { ArrowLeftRight } from "lucide-react";
import { Card } from "@/components/ui/card";
import { EmptyState, PageHeader } from "@/components/ui/misc";
import { Pagination } from "@/components/ui/pagination";
import { DocStatusBadge } from "@/components/erp/badges";
import { NewDocumentMenu } from "@/components/erp/new-document-menu";
import { control, docTypeLabel, submitBtn, tableHead, th, thEnd } from "@/components/erp/labels";
import { getT } from "@/i18n/server";
import { formatKey } from "@/lib/time";
import { STOCK_DOC_STATUSES, STOCK_DOC_TYPES } from "@/lib/inventory";
import { requirePagePermission } from "@/server/auth/session";
import { listDocuments, preparableTypes } from "@/server/services/inventory-documents";
import { warehouseOptions } from "@/server/services/inventory-warehouses";

export async function generateMetadata(): Promise<Metadata> {
  return { title: (await getT())("stock.docs.title") };
}

type SP = { type?: string; status?: string; warehouseId?: string; q?: string; from?: string; to?: string; page?: string };

export default async function StockDocumentsPage({ searchParams }: { searchParams: Promise<SP> }) {
  const [user, t] = await Promise.all([requirePagePermission("inventory.view"), getT()]);
  const sp = await searchParams;
  const [result, warehouses] = await Promise.all([
    listDocuments(user, { ...sp, page: Number(sp.page) || 1 }),
    warehouseOptions(user, { includeInactive: true }),
  ]);
  const L = t.locale;
  const qs = (page: number) => {
    const p = new URLSearchParams();
    for (const [k, v] of Object.entries(sp)) if (v && k !== "page") p.set(k, v);
    p.set("page", String(page));
    return `/stock/documents?${p}`;
  };
  const filtered = Object.entries(sp).some(([k, v]) => v && k !== "page");
  const day = (key: string) => formatKey(key, { day: "numeric", month: "short", year: "numeric" }, L);
  return (
    <>
      <PageHeader title={t("stock.docs.title")} description={t("stock.docs.text")} actions={<NewDocumentMenu t={t} types={preparableTypes(user)} />} />
      <Card className="mb-4 p-4">
        <form method="get" className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-[1fr_11rem_10rem_11rem_9.5rem_9.5rem_auto]">
          <input name="q" defaultValue={sp.q} placeholder={t("stock.docs.search")} aria-label={t("stock.docs.search")} className={control} />
          <select name="type" defaultValue={sp.type ?? ""} aria-label={t("common.type")} className={control}>
            <option value="">{t("stock.docs.allTypes")}</option>
            {STOCK_DOC_TYPES.map((d) => (
              <option key={d} value={d}>
                {t.dyn(`enums.stockDocType.${d}`)}
              </option>
            ))}
          </select>
          <select name="status" defaultValue={sp.status ?? ""} aria-label={t("common.status")} className={control}>
            <option value="">{t("stock.docs.allStatuses")}</option>
            {STOCK_DOC_STATUSES.map((s) => (
              <option key={s} value={s}>
                {t.dyn(`enums.stockDocStatus.${s}`)}
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
          <input type="date" name="from" defaultValue={sp.from} aria-label={t("common.from")} className={control} />
          <input type="date" name="to" defaultValue={sp.to} aria-label={t("common.to")} className={control} />
          <button type="submit" className={submitBtn}>
            {t("common.search")}
          </button>
        </form>
      </Card>
      <Card className="overflow-hidden">
        {result.rows.length === 0 ? (
          <EmptyState title={filtered ? t("stock.docs.noMatch") : t("stock.docs.none")} description={filtered ? undefined : t("stock.docs.noneText")} icon={<ArrowLeftRight className="h-6 w-6" />} />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[760px] text-sm">
              <thead className={tableHead}>
                <tr>
                  <th className={th}>{t("stock.fields.number")}</th>
                  <th className={th}>{t("common.type")}</th>
                  <th className={th}>{t("common.status")}</th>
                  <th className={th}>{t("common.date")}</th>
                  <th className={th}>
                    {t("common.from")} → {t("common.to")}
                  </th>
                  <th className={th}>{t("stock.fields.reference")}</th>
                  <th className={thEnd}>{t("stock.fields.lines")}</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-line">
                {result.rows.map((d) => (
                  <tr key={d.id} className="hover:bg-surface-muted/50">
                    <td className="px-4 py-2.5">
                      <Link href={`/stock/documents/${d.id}`} className="font-mono font-semibold text-brand-text hover:underline">
                        <bdi>{d.number}</bdi>
                      </Link>
                    </td>
                    <td className="px-4 py-2.5">{docTypeLabel(t, d.type, d.returnKind)}</td>
                    <td className="px-4 py-2.5">
                      <DocStatusBadge status={d.status} label={t.dyn(`enums.stockDocStatus.${d.status}`)} />
                    </td>
                    <td className="whitespace-nowrap px-4 py-2.5 text-fg-muted">{day(d.documentDate)}</td>
                    <td className="px-4 py-2.5 font-mono text-fg-muted">
                      <bdi>{[d.from?.code, d.to?.code].filter(Boolean).join(" → ")}</bdi>
                    </td>
                    <td className="px-4 py-2.5 text-fg-muted" dir="auto">
                      {[d.reference, d.counterparty].filter(Boolean).join(" · ") || "—"}
                    </td>
                    <td className="px-4 py-2.5 text-end tabular-nums">{d.lineCount}</td>
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
