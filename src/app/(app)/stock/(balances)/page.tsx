import Link from "next/link";
import type { Metadata } from "next";
import { Download, Layers } from "lucide-react";
import { Card } from "@/components/ui/card";
import { Badge, EmptyState, PageHeader } from "@/components/ui/misc";
import { Pagination } from "@/components/ui/pagination";
import { NewDocumentMenu } from "@/components/erp/new-document-menu";
import { control, nameOf, submitBtn, tableHead, th, thEnd } from "@/components/erp/labels";
import { buttonClasses } from "@/components/ui/button";
import { getT } from "@/i18n/server";
import { money } from "@/lib/constants";
import { formatQuantity } from "@/lib/inventory";
import { hasPermission, vehicleScoped } from "@/server/access";
import { requirePagePermission } from "@/server/auth/session";
import { catalogOptions } from "@/server/services/inventory-catalog";
import { preparableTypes } from "@/server/services/inventory-documents";
import { listBalances } from "@/server/services/inventory-stock";
import { warehouseOptions } from "@/server/services/inventory-warehouses";

export async function generateMetadata(): Promise<Metadata> {
  const [t, user] = [await getT(), await requirePagePermission("inventory.view")];
  return { title: vehicleScoped(user) ? t("stock.titleTech") : t("stock.title") };
}

type SP = { view?: string; warehouseId?: string; q?: string; categoryId?: string; low?: string; page?: string };

export default async function StockPage({ searchParams }: { searchParams: Promise<SP> }) {
  const [user, t] = await Promise.all([requirePagePermission("inventory.view"), getT()]);
  const sp = await searchParams;
  const own = vehicleScoped(user);
  const view = sp.view === "location" || own ? "location" : "product";
  const [result, warehouses, options] = await Promise.all([
    listBalances(user, { view, warehouseId: sp.warehouseId, q: sp.q, categoryId: sp.categoryId, low: sp.low, page: Number(sp.page) || 1 }),
    warehouseOptions(user, { includeInactive: true }),
    hasPermission(user, "products.view") ? catalogOptions(user) : Promise.resolve(null),
  ]);
  const L = t.locale;
  const costs = result.totalValue !== null;
  const filters = new URLSearchParams();
  for (const [k, v] of Object.entries(sp)) if (v && k !== "page") filters.set(k, v);
  const qs = (page: number) => {
    const p = new URLSearchParams(filters);
    p.set("page", String(page));
    return `/stock?${p}`;
  };
  const filtered = !!(sp.q || sp.categoryId || sp.low || sp.warehouseId);
  return (
    <>
      <PageHeader
        title={own ? t("stock.titleTech") : t("stock.title")}
        description={own ? t("stock.textTech") : t("stock.text")}
        actions={
          <>
            {hasPermission(user, "inventory.reports") && (
              <a href={`/api/inventory/export?kind=balances&${filters}`} className={buttonClasses("outline")} download>
                <Download className="h-4 w-4" /> {t("stock.exportCsv")}
              </a>
            )}
            <NewDocumentMenu t={t} types={preparableTypes(user)} />
          </>
        }
      />
      <Card className="mb-4 p-4">
        <form method="get" className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-[1fr_12rem_12rem_12rem_auto]">
          <input name="q" defaultValue={sp.q} placeholder={t("stock.search")} aria-label={t("stock.search")} className={control} />
          {!own && (
            <select name="view" defaultValue={view} aria-label={t("stock.view")} className={control}>
              <option value="product">{t("stock.byProduct")}</option>
              <option value="location">{t("stock.byLocation")}</option>
            </select>
          )}
          {warehouses.length > 1 && (
            <select name="warehouseId" defaultValue={sp.warehouseId ?? ""} aria-label={t("stock.fields.warehouse")} className={control}>
              <option value="">{t("stock.allWarehouses")}</option>
              {warehouses.map((w) => (
                <option key={w.id} value={w.id}>
                  {w.code} · {nameOf(w, t)}
                </option>
              ))}
            </select>
          )}
          {options && (
            <select name="categoryId" defaultValue={sp.categoryId ?? ""} aria-label={t("catalog.products.category")} className={control}>
              <option value="">{t("catalog.allCategories")}</option>
              {options.categories.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.parentId ? `— ${nameOf(c, t)}` : nameOf(c, t)}
                </option>
              ))}
            </select>
          )}
          <div className="flex items-center gap-3">
            {result.lowAvailable && view === "product" && (
              <label className="flex items-center gap-2 text-sm text-fg">
                <input type="checkbox" name="low" value="1" defaultChecked={sp.low === "1"} className="h-4 w-4 accent-[var(--brand-strong)]" />
                {t("stock.lowOnly")}
              </label>
            )}
            <button type="submit" className={submitBtn}>
              {t("common.search")}
            </button>
          </div>
        </form>
      </Card>
      {costs && (
        <p className="mb-3 text-sm font-medium text-fg-muted" role="status">
          {t("stock.totalValue", { amount: money(result.totalValue, L) })}
        </p>
      )}
      <Card className="overflow-hidden">
        {result.rows.length === 0 ? (
          <EmptyState
            title={filtered ? t("stock.noMatch") : t("stock.none")}
            description={filtered ? undefined : own ? t("stock.noneTech") : t("stock.noneText")}
            icon={<Layers className="h-6 w-6" />}
          />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[640px] text-sm">
              <thead className={tableHead}>
                <tr>
                  <th className={th}>{t("stock.fields.sku")}</th>
                  <th className={th}>{t("stock.fields.product")}</th>
                  {view === "location" && <th className={th}>{t("stock.fields.warehouse")}</th>}
                  {view === "location" && <th className={th}>{t("stock.fields.bin")}</th>}
                  <th className={thEnd}>{t("stock.fields.quantity")}</th>
                  {view === "product" && <th className={thEnd}>{t("stock.fields.minStock")}</th>}
                  {costs && <th className={thEnd}>{t("stock.fields.value")}</th>}
                </tr>
              </thead>
              <tbody className="divide-y divide-line">
                {result.rows.map((b) => (
                  <tr key={`${b.productId}-${b.warehouse?.id ?? ""}-${b.bin ?? ""}`} className="hover:bg-surface-muted/50">
                    <td className="px-4 py-2.5">
                      <Link prefetch={false} href={`/stock/movements?productId=${b.productId}${b.warehouse ? `&warehouseId=${b.warehouse.id}` : ""}`} className="font-mono font-semibold text-brand-text hover:underline">
                        <bdi>{b.sku}</bdi>
                      </Link>
                    </td>
                    <td className="px-4 py-2.5">
                      <span className="font-medium text-fg">{nameOf(b, t)}</span>
                      {b.low && <Badge className="ms-2 border-warning/40 bg-warning-soft text-fg">{t("stock.lowBadge")}</Badge>}
                    </td>
                    {view === "location" && (
                      <td className="px-4 py-2.5">
                        <bdi className="font-mono">{b.warehouse?.code}</bdi>
                      </td>
                    )}
                    {view === "location" && <td className="px-4 py-2.5 font-mono text-fg-muted">{b.bin ?? "—"}</td>}
                    <td className={`px-4 py-2.5 text-end tabular-nums ${b.quantity < 0 ? "text-danger" : ""}`}>
                      {formatQuantity(b.quantity, L)} <span className="text-xs text-fg-subtle">{b.unitCode}</span>
                    </td>
                    {view === "product" && <td className="px-4 py-2.5 text-end tabular-nums text-fg-muted">{b.minStock ? formatQuantity(b.minStock, L) : "—"}</td>}
                    {costs && <td className="px-4 py-2.5 text-end tabular-nums">{money(b.value, L)}</td>}
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
