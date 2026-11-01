import Link from "next/link";
import type { Metadata } from "next";
import { BackArrow, PageHeader } from "@/components/ui/misc";
import { BrandsManager, CategoriesManager, UnitsManager } from "@/components/erp/catalog-setup";
import { getT } from "@/i18n/server";
import { requirePagePermission } from "@/server/auth/session";
import { listBrands, listCategories, listUnits } from "@/server/services/inventory-catalog";

export async function generateMetadata(): Promise<Metadata> {
  return { title: (await getT())("catalog.setup") };
}

export default async function CatalogSetupPage() {
  const [user, t] = await Promise.all([requirePagePermission("products.manage"), getT()]);
  const [units, categories, brands] = await Promise.all([listUnits(user), listCategories(user), listBrands(user)]);
  return (
    <>
      <PageHeader
        breadcrumb={
          <Link href="/products" className="hover:text-fg">
            <BackArrow /> {t("catalog.backToProducts")}
          </Link>
        }
        title={t("catalog.setup")}
        description={t("catalog.setupText")}
      />
      <div className="grid grid-cols-1 gap-6 xl:grid-cols-3">
        <UnitsManager units={units} />
        <CategoriesManager categories={categories} />
        <BrandsManager brands={brands} />
      </div>
    </>
  );
}
