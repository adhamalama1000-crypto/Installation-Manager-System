import Link from "next/link";
import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { BackArrow, PageHeader } from "@/components/ui/misc";
import { DocumentForm } from "@/components/erp/document-form";
import { getT } from "@/i18n/server";
import { requirePagePermission } from "@/server/auth/session";
import { canSeeCosts, today } from "@/server/services/inventory-common";
import { getDocument } from "@/server/services/inventory-documents";
import { warehouseOptions } from "@/server/services/inventory-warehouses";
import { loadOr404 } from "../../../../appointments/[id]/load";

export async function generateMetadata(): Promise<Metadata> {
  return { title: (await getT())("stock.detail.editDraft") };
}

export default async function EditStockDocumentPage({ params }: { params: Promise<{ id: string }> }) {
  const [user, t] = await Promise.all([requirePagePermission("inventory.view"), getT()]);
  const { id } = await params;
  const d = await loadOr404(() => getDocument(user, id));
  if (!d.can.edit) redirect(`/stock/documents/${d.id}`);
  const warehouses = await warehouseOptions(user);
  return (
    <>
      <PageHeader
        breadcrumb={
          <Link href={`/stock/documents/${d.id}`} className="hover:text-fg">
            <BackArrow /> <bdi>{d.number}</bdi>
          </Link>
        }
        title={t("stock.form.titleEdit", { number: d.number })}
      />
      <DocumentForm
        type={d.type}
        returnKind={d.returnKind}
        warehouses={warehouses}
        canPost={d.can.post}
        showCosts={canSeeCosts(user)}
        today={today(user)}
        initial={{
          id: d.id,
          number: d.number,
          version: d.version,
          fromWarehouseId: d.from?.id ?? null,
          toWarehouseId: d.to?.id ?? null,
          documentDate: d.documentDate,
          reference: d.reference,
          counterparty: d.counterparty,
          note: d.note,
          lines: d.lines.map((l) => ({
            product: { id: l.product.id, sku: l.product.sku, nameEn: l.product.nameEn, nameAr: l.product.nameAr, trackSerials: l.product.trackSerials, serialsOptional: l.product.serialsOptional, unit: { code: l.product.unit.code, allowsFraction: l.product.unit.allowsFraction } },
            quantity: l.quantity,
            unitCost: l.unitCost,
            fromBinId: l.fromBin?.id ?? null,
            toBinId: l.toBin?.id ?? null,
            direction: l.direction,
            serials: l.serials,
            reason: l.reason,
          })),
        }}
      />
    </>
  );
}
