import Link from "next/link";
import type { Metadata } from "next";
import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { Alert, BackArrow, Badge, DefinitionList, PageHeader } from "@/components/ui/misc";
import { SupplierForm } from "@/components/erp/supplier-form";
import { DocStatusBadge } from "@/components/erp/badges";
import { docTypeLabel, tableHead, th, thEnd } from "@/components/erp/labels";
import { getT } from "@/i18n/server";
import { formatKey } from "@/lib/time";
import { hasPermission } from "@/server/access";
import { requirePagePermission } from "@/server/auth/session";
import { getSupplier } from "@/server/services/suppliers";
import { loadOr404 } from "../../appointments/[id]/load";

export async function generateMetadata(): Promise<Metadata> {
  return { title: (await getT())("suppliers.title") };
}

export default async function SupplierPage({ params }: { params: Promise<{ id: string }> }) {
  const [user, t] = await Promise.all([requirePagePermission("suppliers.view"), getT()]);
  const { id } = await params;
  const s = await loadOr404(() => getSupplier(user, id));
  const manage = hasPermission(user, "suppliers.manage");
  return (
    <>
      <PageHeader
        breadcrumb={
          <Link href="/suppliers" className="hover:text-fg">
            <BackArrow /> {t("suppliers.title")}
          </Link>
        }
        title={
          <span className="flex flex-wrap items-center gap-3">
            <bdi className="font-mono">{s.code}</bdi> <span dir="auto">{s.name}</span>
            {!s.isActive && <Badge>{t("common.inactive")}</Badge>}
          </span>
        }
        description={s.nameAr ?? undefined}
      />
      <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
        <Card>
          <CardHeader title={t("common.details")} />
          <CardBody>
            <DefinitionList
              items={[
                { label: t("suppliers.contactPerson"), value: s.contactPerson },
                { label: t("suppliers.phone"), value: s.phone && <a href={`tel:${s.phone}`} dir="ltr" className="text-brand-text hover:underline">{s.phone}</a> },
                { label: t("suppliers.email"), value: s.email && <a href={`mailto:${s.email}`} className="text-brand-text hover:underline">{s.email}</a> },
                { label: t("suppliers.taxNumber"), value: s.taxNumber },
                { label: t("suppliers.address"), value: s.address && <span dir="auto">{s.address}</span>, full: true },
                { label: t("suppliers.notes"), value: s.notes && <span dir="auto">{s.notes}</span>, full: true },
              ]}
            />
          </CardBody>
        </Card>
        <Card className="overflow-hidden">
          <CardHeader title={t("suppliers.documents")} />
          {s.documents.length === 0 ? (
            <Alert className="m-5">{t("suppliers.noDocuments")}</Alert>
          ) : (
            <table className="w-full text-sm">
              <thead className={tableHead}>
                <tr>
                  <th className={th}>{t("stock.fields.number")}</th>
                  <th className={th}>{t("stock.fields.movementType")}</th>
                  <th className={th}>{t("stock.fields.documentDate")}</th>
                  <th className={thEnd}>{t("common.status")}</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-line">
                {s.documents.map((d) => (
                  <tr key={d.id}>
                    <td className="px-4 py-2">
                      <Link prefetch={false} href={`/stock/documents/${d.id}`} className="font-mono font-semibold text-brand-text hover:underline">
                        {d.number}
                      </Link>
                    </td>
                    <td className="px-4 py-2">{docTypeLabel(t, d.type, d.returnKind)}</td>
                    <td className="px-4 py-2 text-fg-muted">{formatKey(d.documentDate, { day: "numeric", month: "short", year: "numeric" }, t.locale)}</td>
                    <td className="px-4 py-2 text-end">
                      <DocStatusBadge status={d.status} label={t.dyn(`enums.stockDocStatus.${d.status}`)} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Card>
      </div>
      {manage && (
        <div className="mt-6 max-w-3xl">
          <SupplierForm initial={s} />
        </div>
      )}
    </>
  );
}
