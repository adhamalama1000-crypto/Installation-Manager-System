import Link from "next/link";
import type { Metadata } from "next";
import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { Alert, BackArrow, Badge, DefinitionList, PageHeader } from "@/components/ui/misc";
import { ProductForm } from "@/components/erp/product-form";
import { nameOf, tableHead, th, thEnd } from "@/components/erp/labels";
import { getT } from "@/i18n/server";
import { money } from "@/lib/constants";
import { formatQuantity } from "@/lib/inventory";
import { hasPermission } from "@/server/access";
import { requirePagePermission } from "@/server/auth/session";
import { catalogOptions, getProduct } from "@/server/services/inventory-catalog";
import { canSeeCosts } from "@/server/services/inventory-common";
import { loadOr404 } from "../../appointments/[id]/load";

export async function generateMetadata(): Promise<Metadata> {
  return { title: (await getT())("catalog.title") };
}

export default async function ProductPage({ params }: { params: Promise<{ id: string }> }) {
  const [user, t] = await Promise.all([requirePagePermission("products.view"), getT()]);
  const { id } = await params;
  const p = await loadOr404(() => getProduct(user, id));
  const manage = hasPermission(user, "products.manage");
  const options = manage ? await catalogOptions(user) : null;
  const costs = canSeeCosts(user);
  const L = t.locale;
  const inventory = hasPermission(user, "inventory.view");
  return (
    <>
      <PageHeader
        breadcrumb={
          <Link href="/products" className="hover:text-fg">
            <BackArrow /> {t("catalog.backToProducts")}
          </Link>
        }
        title={
          <span className="flex flex-wrap items-center gap-3">
            <bdi className="font-mono">{p.sku}</bdi>
            <span>{nameOf(p, t)}</span>
            {!p.isActive && <Badge>{t("common.inactive")}</Badge>}
            {p.low && <Badge className="border-warning/40 bg-warning-soft text-fg">{t("catalog.lowStock")}</Badge>}
          </span>
        }
        description={t.locale === "ar" ? p.nameEn : p.nameAr}
        actions={
          inventory && (
            <Link href={`/stock/movements?productId=${p.id}`} className="text-sm font-medium text-brand-text hover:underline">
              {t("catalog.viewLedger")}
            </Link>
          )
        }
      />
      <div className="grid grid-cols-1 gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
        <Card>
          <CardHeader title={t("common.details")} />
          <CardBody>
            <DefinitionList
              items={[
                { label: t("catalog.products.barcode"), value: p.barcode && <bdi className="font-mono">{p.barcode}</bdi> },
                { label: t("catalog.products.unit"), value: `${nameOf(p.unit, t)} (${p.unit.code})` },
                { label: t("catalog.products.category"), value: p.category && [p.parentCategory && nameOf(p.parentCategory, t), nameOf(p.category, t)].filter(Boolean).join(" › ") },
                { label: t("catalog.products.brand"), value: p.brand?.name },
                { label: t("catalog.products.model"), value: p.model },
                { label: t("catalog.products.warrantyMonths"), value: p.warrantyMonths || null },
                ...(costs
                  ? [
                      { label: t("catalog.products.purchaseCost"), value: money(p.purchaseCost, L) },
                      { label: t("catalog.products.averageCost"), value: money(p.averageCost, L) },
                    ]
                  : []),
                { label: t("catalog.products.sellingPrice"), value: money(p.sellingPrice, L) },
                { label: t("catalog.products.minStock"), value: p.minStock ? formatQuantity(p.minStock, L) : null },
                { label: t("catalog.products.trackSerials"), value: p.trackSerials ? `${t("common.yes")} · ${t("catalog.serialsInStock", { count: p.serialsInStock })}` : t("common.no") },
                { label: t("catalog.products.description"), value: p.description && <span dir="auto">{p.description}</span>, full: true },
              ]}
            />
          </CardBody>
        </Card>
        {inventory && (
          <Card className="overflow-hidden">
            <CardHeader title={t("catalog.stockByWarehouse")} description={`${t("catalog.onHand")}: ${formatQuantity(p.onHand, L)} ${p.unit.code}`} />
            {p.balances.length === 0 ? (
              <Alert className="m-5">{t("catalog.noStock")}</Alert>
            ) : (
              <table className="w-full text-sm">
                <thead className={tableHead}>
                  <tr>
                    <th className={th}>{t("stock.fields.warehouse")}</th>
                    <th className={th}>{t("stock.fields.bin")}</th>
                    <th className={thEnd}>{t("stock.fields.quantity")}</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-line">
                  {p.balances.map((b) => (
                    <tr key={`${b.warehouseId}-${b.bin ?? ""}`}>
                      <td className="px-4 py-2">
                        <bdi className="font-mono font-semibold">{b.code}</bdi> <span className="text-fg-muted">{nameOf(b, t)}</span>
                      </td>
                      <td className="px-4 py-2 font-mono text-fg-muted">{b.bin ?? "—"}</td>
                      <td className={`px-4 py-2 text-end tabular-nums ${b.quantity < 0 ? "text-danger" : ""}`}>{formatQuantity(b.quantity, L)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </Card>
        )}
      </div>
      {manage && options && (
        <div className="mt-6 max-w-3xl">
          <ProductForm
            options={options}
            initial={{
              id: p.id,
              version: p.version,
              sku: p.sku,
              barcode: p.barcode,
              nameEn: p.nameEn,
              nameAr: p.nameAr,
              model: p.model,
              description: p.description,
              unitId: p.unit.id,
              categoryId: p.category?.id ?? null,
              parentCategoryId: p.parentCategory?.id ?? null,
              brandId: p.brand?.id ?? null,
              purchaseCost: p.purchaseCost,
              sellingPrice: p.sellingPrice,
              minStock: p.minStock,
              warrantyMonths: p.warrantyMonths,
              trackSerials: p.trackSerials,
              isActive: p.isActive,
              hasMovements: p.hasMovements,
            }}
          />
        </div>
      )}
    </>
  );
}
