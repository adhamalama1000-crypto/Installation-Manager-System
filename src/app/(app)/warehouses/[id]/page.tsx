import Link from "next/link";
import type { Metadata } from "next";
import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { Alert, BackArrow, Badge, DefinitionList, PageHeader } from "@/components/ui/misc";
import { BinsManager, WarehouseDialogButton } from "@/components/erp/warehouse-forms";
import { nameOf } from "@/components/erp/labels";
import { getT } from "@/i18n/server";
import { money } from "@/lib/constants";
import { hasPermission } from "@/server/access";
import { requirePagePermission } from "@/server/auth/session";
import { getWarehouse, technicianOptions } from "@/server/services/inventory-warehouses";
import { loadOr404 } from "../../appointments/[id]/load";

export async function generateMetadata(): Promise<Metadata> {
  return { title: (await getT())("warehouses.title") };
}

export default async function WarehousePage({ params }: { params: Promise<{ id: string }> }) {
  const [user, t] = await Promise.all([requirePagePermission("warehouses.view"), getT()]);
  const { id } = await params;
  const w = await loadOr404(() => getWarehouse(user, id));
  const manage = hasPermission(user, "warehouses.manage");
  const technicians = manage ? await technicianOptions(user) : [];
  const inventory = hasPermission(user, "inventory.view");
  return (
    <>
      <PageHeader
        breadcrumb={
          <Link href="/warehouses" className="hover:text-fg">
            <BackArrow /> {t("warehouses.backToWarehouses")}
          </Link>
        }
        title={
          <span className="flex flex-wrap items-center gap-3">
            <bdi className="font-mono">{w.code}</bdi>
            <span>{nameOf(w, t)}</span>
            {!w.isActive && <Badge>{t("common.inactive")}</Badge>}
          </span>
        }
        description={t.dyn(`enums.warehouseKind.${w.kind}`)}
        actions={
          <>
            {inventory && (
              <>
                <Link href={`/stock?view=location&warehouseId=${w.id}`} className="text-sm font-medium text-brand-text hover:underline">
                  {t("warehouses.viewStock")}
                </Link>
                <Link href={`/stock/movements?warehouseId=${w.id}`} className="text-sm font-medium text-brand-text hover:underline">
                  {t("warehouses.viewLedger")}
                </Link>
              </>
            )}
            {manage && (
              <WarehouseDialogButton
                technicians={technicians}
                initial={{
                  id: w.id,
                  version: w.version,
                  code: w.code,
                  nameEn: w.nameEn,
                  nameAr: w.nameAr,
                  kind: w.kind,
                  technicianId: w.technician?.id ?? null,
                  address: w.address,
                  allowNegative: w.allowNegative,
                  isActive: w.isActive,
                }}
              />
            )}
          </>
        }
      />
      {w.openStocktake && (
        <Alert tone="info" className="mb-4" title={t("warehouses.frozen")}>
          {hasPermission(user, "inventory.count") || hasPermission(user, "inventory.approve") ? (
            <Link href={`/stocktakes/${w.openStocktake.id}`} className="hover:underline">
              {t("warehouses.frozenText", { number: w.openStocktake.number })}
            </Link>
          ) : (
            t("warehouses.frozenText", { number: w.openStocktake.number })
          )}
        </Alert>
      )}
      <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
        <Card>
          <CardHeader title={t("common.details")} />
          <CardBody>
            <DefinitionList
              items={[
                { label: t("warehouses.kind"), value: t.dyn(`enums.warehouseKind.${w.kind}`) },
                ...(w.technician ? [{ label: t("warehouses.technician"), value: w.technician.name }] : []),
                { label: t("warehouses.productsInStock"), value: w.productCount },
                ...(w.value !== null ? [{ label: t("warehouses.value"), value: money(w.value, t.locale) }] : []),
                { label: t("warehouses.allowNegative"), value: w.allowNegative ? t("common.yes") : t("common.no") },
                { label: t("warehouses.address"), value: w.address && <span dir="auto">{w.address}</span>, full: true },
              ]}
            />
          </CardBody>
        </Card>
        <BinsManager warehouseId={w.id} bins={w.bins} manage={manage} />
      </div>
    </>
  );
}
