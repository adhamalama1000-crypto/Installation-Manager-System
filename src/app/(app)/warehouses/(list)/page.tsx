import Link from "next/link";
import type { Metadata } from "next";
import { Truck, Warehouse } from "lucide-react";
import { Card } from "@/components/ui/card";
import { Badge, EmptyState, PageHeader } from "@/components/ui/misc";
import { Pagination } from "@/components/ui/pagination";
import { WarehouseDialogButton } from "@/components/erp/warehouse-forms";
import { control, nameOf, submitBtn, tableHead, th, thEnd } from "@/components/erp/labels";
import { getT } from "@/i18n/server";
import { money } from "@/lib/constants";
import { hasPermission, vehicleScoped } from "@/server/access";
import { requirePagePermission } from "@/server/auth/session";
import { listWarehouses, technicianOptions } from "@/server/services/inventory-warehouses";

export async function generateMetadata(): Promise<Metadata> {
  return { title: (await getT())("warehouses.title") };
}

type SP = { q?: string; kind?: string; active?: string; page?: string };

export default async function WarehousesPage({ searchParams }: { searchParams: Promise<SP> }) {
  const [user, t] = await Promise.all([requirePagePermission("warehouses.view"), getT()]);
  const sp = await searchParams;
  const manage = hasPermission(user, "warehouses.manage");
  const [result, technicians] = await Promise.all([
    listWarehouses(user, { q: sp.q, kind: sp.kind, active: sp.active, page: Number(sp.page) || 1 }),
    manage ? technicianOptions(user) : Promise.resolve([]),
  ]);
  const L = t.locale;
  const own = vehicleScoped(user);
  const costs = result.rows.some((w) => w.value !== null);
  const qs = (page: number) => {
    const p = new URLSearchParams();
    for (const [k, v] of Object.entries(sp)) if (v && k !== "page") p.set(k, v);
    p.set("page", String(page));
    return `/warehouses?${p}`;
  };
  return (
    <>
      <PageHeader title={t("warehouses.title")} description={own ? t("warehouses.textTech") : t("warehouses.text")} actions={manage && <WarehouseDialogButton technicians={technicians} />} />
      {!own && (
        <Card className="mb-4 p-4">
          <form method="get" className="grid grid-cols-1 gap-3 sm:grid-cols-[1fr_12rem_10rem_auto]">
            <input name="q" defaultValue={sp.q} placeholder={t("warehouses.search")} aria-label={t("warehouses.search")} className={control} />
            <select name="kind" defaultValue={sp.kind ?? ""} aria-label={t("warehouses.kind")} className={control}>
              <option value="">{t("warehouses.allKinds")}</option>
              <option value="WAREHOUSE">{t("enums.warehouseKind.WAREHOUSE")}</option>
              <option value="VEHICLE">{t("enums.warehouseKind.VEHICLE")}</option>
            </select>
            <select name="active" defaultValue={sp.active ?? "1"} aria-label={t("common.status")} className={control}>
              <option value="1">{t("catalog.activeOnly")}</option>
              <option value="0">{t("catalog.inactiveOnly")}</option>
              <option value="all">{t("common.all")}</option>
            </select>
            <button type="submit" className={submitBtn}>
              {t("common.search")}
            </button>
          </form>
        </Card>
      )}
      <Card className="overflow-hidden">
        {result.rows.length === 0 ? (
          <EmptyState title={t("warehouses.none")} description={own ? t("warehouses.noneTech") : t("warehouses.noneText")} icon={<Warehouse className="h-6 w-6" />} />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[680px] text-sm">
              <thead className={tableHead}>
                <tr>
                  <th className={th}>{t("warehouses.code")}</th>
                  <th className={th}>{t("common.name")}</th>
                  <th className={th}>{t("warehouses.kind")}</th>
                  <th className={thEnd}>{t("warehouses.productsInStock")}</th>
                  {costs && <th className={thEnd}>{t("warehouses.value")}</th>}
                  <th className={thEnd}>{t("warehouses.binsTitle")}</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-line">
                {result.rows.map((w) => (
                  <tr key={w.id} className="hover:bg-surface-muted/50">
                    <td className="px-4 py-2.5">
                      <Link prefetch={false} href={`/warehouses/${w.id}`} className="font-mono font-semibold text-brand-text hover:underline">
                        <bdi>{w.code}</bdi>
                      </Link>
                    </td>
                    <td className="px-4 py-2.5">
                      <span className="font-medium text-fg">{nameOf(w, t)}</span>
                      <span className="ms-2 inline-flex flex-wrap gap-1 align-middle">
                        {!w.isActive && <Badge>{t("common.inactive")}</Badge>}
                        {w.openStocktake && <Badge className="border-info/30 bg-info-soft text-fg">{t("warehouses.frozen")}</Badge>}
                        {w.allowNegative && <Badge className="border-warning/40 bg-warning-soft text-fg">{t("warehouses.negativeAllowed")}</Badge>}
                      </span>
                    </td>
                    <td className="px-4 py-2.5 text-fg-muted">
                      {w.kind === "VEHICLE" ? (
                        <span className="inline-flex items-center gap-1.5">
                          <Truck className="h-3.5 w-3.5" aria-hidden /> {w.technician?.name}
                        </span>
                      ) : (
                        t("enums.warehouseKind.WAREHOUSE")
                      )}
                    </td>
                    <td className="px-4 py-2.5 text-end tabular-nums">{w.productCount}</td>
                    {costs && <td className="px-4 py-2.5 text-end tabular-nums">{money(w.value, L)}</td>}
                    <td className="px-4 py-2.5 text-end tabular-nums">{w.binCount}</td>
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
