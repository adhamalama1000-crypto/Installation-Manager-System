import Link from "next/link";
import type { Metadata } from "next";
import { BackArrow, PageHeader } from "@/components/ui/misc";
import { ProductForm } from "@/components/erp/product-form";
import { getT } from "@/i18n/server";
import { requirePagePermission } from "@/server/auth/session";
import { catalogOptions } from "@/server/services/inventory-catalog";

export async function generateMetadata(): Promise<Metadata> {
  return { title: (await getT())("catalog.newProduct") };
}

export default async function NewProductPage() {
  const [user, t] = await Promise.all([requirePagePermission("products.manage"), getT()]);
  const options = await catalogOptions(user);
  return (
    <>
      <PageHeader
        breadcrumb={
          <Link href="/products" className="hover:text-fg">
            <BackArrow /> {t("catalog.backToProducts")}
          </Link>
        }
        title={t("catalog.newProduct")}
      />
      <div className="max-w-3xl">
        <ProductForm options={options} />
      </div>
    </>
  );
}
