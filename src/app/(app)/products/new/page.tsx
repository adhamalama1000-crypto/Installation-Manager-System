import Link from "next/link";
import type { Metadata } from "next";
import { BackArrow, PageHeader } from "@/components/ui/misc";
import { ProductForm, type ProductCopy } from "@/components/erp/product-form";
import { getT } from "@/i18n/server";
import { requirePagePermission } from "@/server/auth/session";
import { catalogOptions, getProduct } from "@/server/services/inventory-catalog";

export async function generateMetadata(): Promise<Metadata> {
  return { title: (await getT())("catalog.newProduct") };
}

/** ?copy=<id>: a new product filled in from an existing one (codes are generated again). */
export default async function NewProductPage({ searchParams }: { searchParams: Promise<{ copy?: string }> }) {
  const [user, t] = await Promise.all([requirePagePermission("products.manage"), getT()]);
  const { copy } = await searchParams;
  const [options, source] = await Promise.all([catalogOptions(user), copy ? getProduct(user, copy).catch(() => null) : Promise.resolve(null)]);
  const copyFrom: ProductCopy | null =
    source && !source.parent
      ? {
          nameEn: source.nameEn,
          nameAr: source.nameAr,
          model: source.model,
          description: source.description,
          unitId: source.unit.id,
          categoryId: source.category?.id ?? null,
          parentCategoryId: source.parentCategory?.id ?? null,
          brandId: source.brand?.id ?? null,
          purchaseCost: source.purchaseCost,
          sellingPrice: source.sellingPrice,
          minStock: source.minStock,
          warrantyMonths: source.warrantyMonths,
          trackSerials: source.trackSerials,
          serialMode: source.serialMode,
          isActive: true,
        }
      : null;
  return (
    <>
      <PageHeader
        breadcrumb={
          <Link href="/products" className="hover:text-fg">
            <BackArrow /> {t("catalog.backToProducts")}
          </Link>
        }
        title={t("catalog.newProduct")}
        description={copyFrom ? t("forms.duplicateHint") : undefined}
      />
      <div className="max-w-3xl">
        <ProductForm options={options} copyFrom={copyFrom} timezone={user.settings.timezone} />
      </div>
    </>
  );
}
