import Link from "next/link";
import type { Metadata } from "next";
import { Download, ScrollText } from "lucide-react";
import { buttonClasses } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { EmptyState, PageHeader } from "@/components/ui/misc";
import { Pagination } from "@/components/ui/pagination";
import { SignedQty } from "@/components/erp/badges";
import { control, docTypeLabel, nameOf, submitBtn, tableHead, th, thEnd } from "@/components/erp/labels";
import { getT } from "@/i18n/server";
import { money } from "@/lib/constants";
import { dateTime } from "@/lib/format";
import { MOVEMENT_TYPES, formatQuantity } from "@/lib/inventory";
import { hasPermission } from "@/server/access";
import { requirePagePermission } from "@/server/auth/session";
import { listMovements } from "@/server/services/inventory-stock";
import { warehouseOptions } from "@/server/services/inventory-warehouses";

export async function generateMetadata(): Promise<Metadata> {
  return { title: (await getT())("stock.ledger.title") };
}

type SP = { productId?: string; warehouseId?: string; type?: string; q?: string; from?: string; to?: string; page?: string };

export default async function StockLedgerPage({ searchParams }: { searchParams: Promise<SP> }) {
  const [user, t] = await Promise.all([requirePagePermission("inventory.view"), getT()]);
  const sp = await searchParams;
  const [result, warehouses] = await Promise.all([listMovements(user, { ...sp, page: Number(sp.page) || 1 }), warehouseOptions(user, { includeInactive: true })]);
  const tz = user.settings.timezone;
  const L = t.locale;
  const costs = result.rows.some((r) => r.unitCost !== null);
  const filters = new URLSearchParams();
  for (const [k, v] of Object.entries(sp)) if (v && k !== "page") filters.set(k, v);
  const qs = (page: number) => {
    const p = new URLSearchParams(filters);
    p.set("page", String(page));
    return `/stock/movements?${p}`;
  };
  const filtered = filters.size > 0;
  return (
    <>
      <PageHeader
        title={t("stock.ledger.title")}
        description={t("stock.ledger.text")}
        actions={
          hasPermission(user, "inventory.reports") && (
            <a href={`/api/inventory/export?kind=ledger&${filters}`} className={buttonClasses("outline")} download>
              <Download className="h-4 w-4" /> {t("stock.exportCsv")}
            </a>
          )
        }
      />
      <Card className="mb-4 p-4">
        <form method="get" className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-[1fr_12rem_11rem_9.5rem_9.5rem_auto]">
          {sp.productId && <input type="hidden" name="productId" value={sp.productId} />}
          <input name="q" defaultValue={sp.q} placeholder={t("stock.ledger.search")} aria-label={t("stock.ledger.search")} className={control} />
          <select name="type" defaultValue={sp.type ?? ""} aria-label={t("stock.fields.movementType")} className={control}>
            <option value="">{t("stock.ledger.allTypes")}</option>
            {MOVEMENT_TYPES.map((m) => (
              <option key={m} value={m}>
                {t.dyn(`enums.movementType.${m}`)}
              </option>
            ))}
          </select>
          {warehouses.length > 1 ? (
            <select name="warehouseId" defaultValue={sp.warehouseId ?? ""} aria-label={t("stock.fields.warehouse")} className={control}>
              <option value="">{t("stock.allWarehouses")}</option>
              {warehouses.map((w) => (
                <option key={w.id} value={w.id}>
                  {w.code}
                </option>
              ))}
            </select>
          ) : (
            <span className="hidden lg:block" />
          )}
          <input type="date" name="from" defaultValue={sp.from} aria-label={t("common.from")} className={control} />
          <input type="date" name="to" defaultValue={sp.to} aria-label={t("common.to")} className={control} />
          <button type="submit" className={submitBtn}>
            {t("common.search")}
          </button>
        </form>
      </Card>
      <Card className="overflow-hidden">
        {result.rows.length === 0 ? (
          <EmptyState title={filtered ? t("stock.ledger.noMatch") : t("stock.ledger.none")} description={filtered ? undefined : t("stock.ledger.noneText")} icon={<ScrollText className="h-6 w-6" />} />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[860px] text-sm">
              <thead className={tableHead}>
                <tr>
                  <th className={th}>{t("stock.fields.postedAt")}</th>
                  <th className={th}>{t("stock.fields.document")}</th>
                  <th className={th}>{t("stock.fields.movementType")}</th>
                  <th className={th}>{t("stock.fields.product")}</th>
                  <th className={th}>{t("stock.fields.warehouse")}</th>
                  <th className={thEnd}>{t("stock.fields.quantity")}</th>
                  <th className={thEnd}>{t("stock.fields.balanceAfter")}</th>
                  {costs && <th className={thEnd}>{t("stock.fields.unitCost")}</th>}
                  <th className={th}>{t("stock.fields.by")}</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-line">
                {result.rows.map((m) => (
                  <tr key={m.id} className="align-top">
                    <td className="whitespace-nowrap px-4 py-2.5 text-fg-muted">{dateTime(m.createdAt, tz, L)}</td>
                    <td className="px-4 py-2.5">
                      <Link prefetch={false} href={`/stock/documents/${m.document.id}`} className="font-mono font-semibold text-brand-text hover:underline">
                        <bdi>{m.document.number}</bdi>
                      </Link>
                      <span className="block text-xs text-fg-subtle">{docTypeLabel(t, m.document.type, m.document.returnKind)}</span>
                    </td>
                    <td className="px-4 py-2.5">
                      {t.dyn(`enums.movementType.${m.type}`)}
                      {m.reversesId && <span className="block text-xs text-fg-subtle">{t("stock.ledger.reversal")}</span>}
                    </td>
                    <td className="px-4 py-2.5">
                      <bdi className="font-mono font-semibold">{m.product.sku}</bdi> <span>{nameOf(m.product, t)}</span>
                      {m.serials.length > 0 && (
                        <span className="mt-0.5 block font-mono text-xs text-fg-subtle" dir="ltr">
                          {m.serials.join(", ")}
                        </span>
                      )}
                      {m.reason && (
                        <span className="mt-0.5 block text-xs text-fg-subtle" dir="auto">
                          {m.reason}
                        </span>
                      )}
                    </td>
                    <td className="px-4 py-2.5 font-mono">
                      <bdi>{m.bin ? `${m.warehouse.code} / ${m.bin}` : m.warehouse.code}</bdi>
                    </td>
                    <td className="px-4 py-2.5 text-end">
                      <SignedQty value={m.quantity} text={formatQuantity(m.quantity, L)} /> <span className="text-xs text-fg-subtle">{m.product.unit.code}</span>
                    </td>
                    <td className="px-4 py-2.5 text-end tabular-nums">{formatQuantity(m.balanceAfter, L)}</td>
                    {costs && <td className="px-4 py-2.5 text-end tabular-nums">{money(m.unitCost, L)}</td>}
                    <td className="px-4 py-2.5 text-fg-muted">{m.createdBy.name}</td>
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
