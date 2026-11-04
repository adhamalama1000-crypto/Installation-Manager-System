import Link from "next/link";
import type { Metadata } from "next";
import { Copy } from "lucide-react";
import { ButtonLink } from "@/components/ui/button";
import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { Alert, BackArrow, Badge, DefinitionList, PageHeader } from "@/components/ui/misc";
import { ProductForm } from "@/components/erp/product-form";
import { ProductImages } from "@/components/erp/product-images";
import { EditVariantButton, VariantsPanel } from "@/components/erp/variants-panel";
import { Ean13 } from "@/components/erp/barcode";
import { nameOf, tableHead, th, thEnd } from "@/components/erp/labels";
import { getT } from "@/i18n/server";
import { money } from "@/lib/constants";
import { formatQuantity } from "@/lib/inventory";
import { isValidEan13 } from "@/lib/product-codes";
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
  const options = manage && !p.parent ? await catalogOptions(user) : null;
  const costs = canSeeCosts(user);
  const L = t.locale;
  const inventory = hasPermission(user, "inventory.view");
  const isVariant = !!p.parent;
  const variantRow = {
    id: p.id,
    sku: p.sku,
    barcode: p.barcode,
    variantNameEn: p.variantNameEn,
    variantNameAr: p.variantNameAr,
    colorHex: p.colorHex,
    purchaseCost: p.purchaseCost,
    sellingPrice: p.sellingPrice,
    minStock: p.minStock,
    isActive: p.isActive,
    version: p.version,
    onHand: p.onHand,
    low: p.low,
    imageUrl: p.imageUrl,
  };
  return (
    <>
      <PageHeader
        breadcrumb={
          p.parent ? (
            <Link href={`/products/${p.parent.id}`} className="hover:text-fg">
              <BackArrow /> {t("variants.variantOf", { product: `${p.parent.sku} ${nameOf(p.parent, t)}` })}
            </Link>
          ) : (
            <Link href="/products" className="hover:text-fg">
              <BackArrow /> {t("catalog.backToProducts")}
            </Link>
          )
        }
        title={
          <span className="flex flex-wrap items-center gap-3">
            {p.colorHex && <span className="inline-block h-5 w-5 rounded border border-line-strong" style={{ backgroundColor: p.colorHex }} aria-hidden />}
            <bdi className="font-mono">{p.sku}</bdi>
            <span>{nameOf(p, t)}</span>
            {!p.isActive && <Badge>{t("common.inactive")}</Badge>}
            {p.hasVariants && <Badge>{t("variants.count", { count: p.variantCount })}</Badge>}
            {p.low && <Badge className="border-warning/40 bg-warning-soft text-fg">{t("catalog.lowStock")}</Badge>}
          </span>
        }
        description={t.locale === "ar" ? p.nameEn : p.nameAr}
        actions={
          <div className="flex flex-wrap items-center gap-3">
            {inventory && !p.hasVariants && (
              <Link href={`/stock/movements?productId=${p.id}`} className="text-sm font-medium text-brand-text hover:underline">
                {t("catalog.viewLedger")}
              </Link>
            )}
            {manage && isVariant && p.parent && <EditVariantButton productId={p.parent.id} variant={variantRow} showCosts={costs} />}
            {manage && !isVariant && (
              <ButtonLink href={`/products/new?copy=${p.id}`} variant="outline" size="sm">
                <Copy className="h-4 w-4" /> {t("forms.duplicate")}
              </ButtonLink>
            )}
          </div>
        }
      />
      <div className="grid grid-cols-1 gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
        <Card>
          <CardHeader title={t("common.details")} description={isVariant && p.parent ? t("variants.sharedFromParent", { product: nameOf(p.parent, t) }) : undefined} />
          <CardBody>
            <DefinitionList
              items={[
                {
                  label: t("catalog.products.barcode"),
                  value: p.barcode && (
                    <span className="flex flex-col items-start gap-1">
                      <bdi className="font-mono">{p.barcode}</bdi>
                      {isValidEan13(p.barcode) && <Ean13 code={p.barcode} className="h-14 w-auto" />}
                    </span>
                  ),
                },
                { label: t("catalog.products.unit"), value: `${nameOf(p.unit, t)} (${p.unit.code})` },
                { label: t("catalog.products.category"), value: p.category && [p.parentCategory && nameOf(p.parentCategory, t), nameOf(p.category, t)].filter(Boolean).join(" › ") },
                { label: t("catalog.products.brand"), value: p.brand?.name },
                { label: t("catalog.products.model"), value: p.model },
                { label: t("catalog.products.warrantyMonths"), value: p.warrantyMonths || null },
                ...(costs
                  ? [
                      { label: t("catalog.products.purchaseCost"), value: money(p.purchaseCost, L) },
                      ...(p.hasVariants ? [] : [{ label: t("catalog.products.averageCost"), value: money(p.averageCost, L) }]),
                    ]
                  : []),
                { label: t("catalog.products.sellingPrice"), value: money(p.sellingPrice, L) },
                { label: t("catalog.products.minStock"), value: p.minStock && !p.hasVariants ? formatQuantity(p.minStock, L) : null },
                {
                  label: t("serialModes.label"),
                  value: `${t(`serialModes.${p.serialMode}`)}${p.serialMode !== "NONE" ? ` · ${t("catalog.serialsInStock", { count: p.serialsInStock })}` : ""}`,
                },
                { label: t("catalog.products.description"), value: p.description && <span dir="auto">{p.description}</span>, full: true },
              ]}
            />
          </CardBody>
        </Card>
        {inventory && (
          <Card className="overflow-hidden">
            <CardHeader
              title={t("catalog.stockByWarehouse")}
              description={`${t("catalog.onHand")}: ${formatQuantity(p.onHand, L)} ${p.unit.code}${p.hasVariants ? ` · ${t("variants.stockOnVariants")}` : ""}`}
            />
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
      {!isVariant && (p.hasVariants || manage) && (
        <div className="mt-6">
          <VariantsPanel
            productId={p.id}
            productName={`${p.sku} ${nameOf(p, t)}`}
            variants={p.variants.map((v) => ({ ...v }))}
            manage={manage && p.isActive}
            showCosts={costs}
            unitCode={p.unit.code}
            stockedOnParent={!p.hasVariants && p.onHand !== 0}
          />
        </div>
      )}
      <div className="mt-6 grid grid-cols-1 gap-6 lg:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]">
        {manage && options && !isVariant && (
          <ProductForm
            options={options}
            timezone={user.settings.timezone}
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
              serialMode: p.serialMode,
              isActive: p.isActive,
              hasMovements: p.hasMovements,
              hasVariants: p.hasVariants,
            }}
          />
        )}
        {(manage || p.images.length > 0) && <ProductImages productId={p.id} productName={nameOf(p, t)} images={p.images} manage={manage} />}
      </div>
    </>
  );
}
