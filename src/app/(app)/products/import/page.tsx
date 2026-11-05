import Link from "next/link";
import type { Metadata } from "next";
import { BackArrow, PageHeader } from "@/components/ui/misc";
import { ProductImport } from "@/components/erp/product-import";
import { getT } from "@/i18n/server";
import { hasPermission } from "@/server/access";
import { requirePagePermission } from "@/server/auth/session";

export async function generateMetadata(): Promise<Metadata> {
  return { title: (await getT())("productImport.title") };
}

export default async function ProductImportPage() {
  const [user, t] = await Promise.all([requirePagePermission("products.manage"), getT()]);
  return (
    <>
      <PageHeader
        breadcrumb={
          <Link href="/products" className="hover:text-fg">
            <BackArrow /> {t("catalog.backToProducts")}
          </Link>
        }
        title={t("productImport.title")}
        description={t("productImport.text")}
      />
      <div className="max-w-5xl">
        <ProductImport canOpenStock={hasPermission(user, "inventory.approve")} />
      </div>
    </>
  );
}
