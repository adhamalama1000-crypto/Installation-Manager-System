import Link from "next/link";
import type { Metadata } from "next";
import { redirect } from "next/navigation";
import type { StockDocType, StockReturnKind } from "@prisma/client";
import { Alert, BackArrow, PageHeader } from "@/components/ui/misc";
import { DocumentForm } from "@/components/erp/document-form";
import { docTypeLabel } from "@/components/erp/labels";
import { getT } from "@/i18n/server";
import { RETURN_KINDS, STOCK_DOC_TYPES, docPermissions } from "@/lib/inventory";
import { hasPermission } from "@/server/access";
import { requirePagePermission } from "@/server/auth/session";
import { canSeeCosts, today } from "@/server/services/inventory-common";
import { warehouseOptions } from "@/server/services/inventory-warehouses";

export async function generateMetadata(): Promise<Metadata> {
  return { title: (await getT())("stock.newDocument") };
}

type SP = { type?: string; returnKind?: string };

export default async function NewStockDocumentPage({ searchParams }: { searchParams: Promise<SP> }) {
  const [user, t] = await Promise.all([requirePagePermission("inventory.view"), getT()]);
  const sp = await searchParams;
  const type = (STOCK_DOC_TYPES as string[]).includes(sp.type ?? "") ? (sp.type as StockDocType) : "RECEIPT";
  const returnKind = type === "RETURN" ? ((RETURN_KINDS as string[]).includes(sp.returnKind ?? "") ? (sp.returnKind as StockReturnKind) : "CUSTOMER") : null;
  const perms = docPermissions(type, returnKind);
  if (!hasPermission(user, perms.prepare)) redirect("/access-denied");
  const warehouses = await warehouseOptions(user);
  const label = docTypeLabel(t, type, returnKind);
  return (
    <>
      <PageHeader
        breadcrumb={
          <Link href="/stock/documents" className="hover:text-fg">
            <BackArrow /> {t("stock.detail.backToDocuments")}
          </Link>
        }
        title={t("stock.form.titleNew", { type: label })}
      />
      {warehouses.length === 0 ? (
        <Alert tone="warning" title={t("stock.form.noWarehouses")}>
          {hasPermission(user, "warehouses.view") && (
            <Link href="/warehouses" className="font-medium text-brand-text hover:underline">
              {t("stock.form.noWarehousesLink")}
            </Link>
          )}
        </Alert>
      ) : (
        <DocumentForm type={type} returnKind={returnKind} warehouses={warehouses} canPost={hasPermission(user, perms.post)} showCosts={canSeeCosts(user)} today={today(user)} />
      )}
    </>
  );
}
