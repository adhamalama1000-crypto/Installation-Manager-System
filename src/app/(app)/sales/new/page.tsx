import Link from "next/link";
import type { Metadata } from "next";
import { BackArrow, PageHeader } from "@/components/ui/misc";
import { SaleForm } from "@/components/sales/sale-form";
import { getT } from "@/i18n/server";
import { todayKey } from "@/lib/time";
import { hasPermission } from "@/server/access";
import { requirePagePermission } from "@/server/auth/session";
import { saleWarehouses } from "@/server/services/sales";

export async function generateMetadata(): Promise<Metadata> {
  return { title: (await getT())("sales.new") };
}

export default async function NewSalePage() {
  const [user, t] = await Promise.all([requirePagePermission("sales.manage"), getT()]);
  const warehouses = await saleWarehouses(user);
  return (
    <>
      <PageHeader
        breadcrumb={
          <Link href="/sales" className="hover:text-fg">
            <BackArrow /> {t("sales.title")}
          </Link>
        }
        title={t("sales.new")}
      />
      <div className="max-w-5xl">
        <SaleForm warehouses={warehouses} today={todayKey(user.settings.timezone)} timezone={user.settings.timezone} showStock={hasPermission(user, "inventory.view")} />
      </div>
    </>
  );
}
