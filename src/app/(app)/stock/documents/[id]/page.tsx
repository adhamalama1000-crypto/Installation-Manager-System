import Link from "next/link";
import type { Metadata } from "next";
import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { Alert, BackArrow, DefinitionList, PageHeader } from "@/components/ui/misc";
import { DocStatusBadge, SignedQty } from "@/components/erp/badges";
import { DocumentActions } from "@/components/erp/document-actions";
import { docTypeLabel, nameOf, tableHead, th, thEnd } from "@/components/erp/labels";
import { getT } from "@/i18n/server";
import { money } from "@/lib/constants";
import { dateTime } from "@/lib/format";
import { formatQuantity } from "@/lib/inventory";
import { formatKey } from "@/lib/time";
import { hasPermission } from "@/server/access";
import { requirePagePermission } from "@/server/auth/session";
import { getDocument } from "@/server/services/inventory-documents";
import { loadOr404 } from "../../../appointments/[id]/load";

export async function generateMetadata(): Promise<Metadata> {
  return { title: (await getT())("stock.docs.title") };
}

export default async function StockDocumentPage({ params }: { params: Promise<{ id: string }> }) {
  const [user, t] = await Promise.all([requirePagePermission("inventory.view"), getT()]);
  const { id } = await params;
  const d = await loadOr404(() => getDocument(user, id));
  const tz = user.settings.timezone;
  const L = t.locale;
  const wh = (w: { code: string; nameEn: string; nameAr: string } | null) =>
    w && (
      <>
        <bdi className="font-mono font-semibold">{w.code}</bdi> <span className="text-fg-muted">{nameOf(w, t)}</span>
      </>
    );
  const reversed = d.status === "CANCELLED" && d.movements.length > 0;
  return (
    <>
      <PageHeader
        breadcrumb={
          <Link href="/stock/documents" className="hover:text-fg">
            <BackArrow /> {t("stock.detail.backToDocuments")}
          </Link>
        }
        title={
          <span className="flex flex-wrap items-center gap-3">
            <bdi className="font-mono">{d.number}</bdi>
            <DocStatusBadge status={d.status} label={t.dyn(`enums.stockDocStatus.${d.status}`)} className="text-sm" />
          </span>
        }
        description={docTypeLabel(t, d.type, d.returnKind)}
        actions={<DocumentActions id={d.id} number={d.number} version={d.version} can={d.can} />}
      />
      {d.status === "DRAFT" && (
        <Alert tone="warning" className="mb-4">
          {t("stock.detail.draftNotice")}
        </Alert>
      )}
      {d.status === "CANCELLED" && (
        <Alert tone="info" className="mb-4">
          {reversed ? t("stock.detail.reversedNotice") : t("stock.detail.cancelledDraftNotice")}
          {d.cancelReason && <span className="block">{t("stock.detail.cancelReason", { reason: d.cancelReason })}</span>}
        </Alert>
      )}
      <Card className="mb-6">
        <CardHeader title={t("common.details")} />
        <CardBody>
          <DefinitionList
            items={[
              ...(d.from ? [{ label: t("stock.fields.fromWarehouse"), value: wh(d.from) }] : []),
              ...(d.to ? [{ label: d.type === "ADJUSTMENT" ? t("stock.fields.warehouse") : t("stock.fields.toWarehouse"), value: wh(d.to) }] : []),
              { label: t("stock.fields.documentDate"), value: formatKey(d.documentDate, { day: "numeric", month: "long", year: "numeric" }, L) },
              { label: t("stock.fields.reference"), value: d.reference && <span dir="auto">{d.reference}</span> },
              ...(d.supplier
                ? [{ label: t("suppliers.pick"), value: <Link href={`/suppliers/${d.supplier.id}`} className="text-brand-text hover:underline"><bdi className="font-mono">{d.supplier.code}</bdi> <span dir="auto">{t.locale === "ar" && d.supplier.nameAr ? d.supplier.nameAr : d.supplier.name}</span></Link> }]
                : []),
              ...(d.counterparty ? [{ label: d.type === "RECEIPT" || d.returnKind === "SUPPLIER" ? t("stock.fields.supplier") : t("stock.fields.customer"), value: <span dir="auto">{d.counterparty}</span> }] : []),
              ...(d.customer ? [{ label: t("docLinks.customer"), value: <Link href={`/customers/${d.customer.id}`} className="text-brand-text hover:underline" dir="auto">{d.customer.name}</Link> }] : []),
              ...(d.appointment ? [{ label: t("docLinks.visit"), value: <Link href={`/appointments/${d.appointment.id}`} className="font-mono text-brand-text hover:underline">{d.appointment.code}</Link> }] : []),
              ...(d.stocktake
                ? [
                    {
                      label: t("nav.stocktakes"),
                      value:
                        hasPermission(user, "inventory.count") || hasPermission(user, "inventory.approve") ? (
                          <Link href={`/stocktakes/${d.stocktake.id}`} className="text-brand-text hover:underline">
                            {t("stock.detail.fromStocktake", { number: d.stocktake.number })}
                          </Link>
                        ) : (
                          t("stock.detail.fromStocktake", { number: d.stocktake.number })
                        ),
                    },
                  ]
                : []),
              {
                label: t("common.details"),
                value: (
                  <span className="space-y-0.5">
                    <span className="block">{t("stock.detail.createdBy", { name: d.createdBy.name, when: dateTime(d.createdAt, tz, L) })}</span>
                    {d.postedBy && d.postedAt && <span className="block">{t("stock.detail.postedBy", { name: d.postedBy.name, when: dateTime(d.postedAt, tz, L) })}</span>}
                    {d.cancelledBy && d.cancelledAt && <span className="block">{t("stock.detail.cancelledBy", { name: d.cancelledBy.name, when: dateTime(d.cancelledAt, tz, L) })}</span>}
                  </span>
                ),
                full: true,
              },
              { label: t("stock.fields.note"), value: d.note && <span dir="auto">{d.note}</span>, full: true },
            ]}
          />
        </CardBody>
      </Card>
      <Card className="mb-6 overflow-hidden">
        <CardHeader title={t("stock.form.lines")} description={t("stock.docs.lines", { count: d.lines.length })} />
        <div className="overflow-x-auto">
          <table className="w-full min-w-[640px] text-sm">
            <thead className={tableHead}>
              <tr>
                <th className={th}>#</th>
                <th className={th}>{t("stock.fields.product")}</th>
                {d.type === "ADJUSTMENT" && <th className={th}>{t("stock.fields.direction")}</th>}
                <th className={thEnd}>{t("stock.fields.quantity")}</th>
                <th className={th}>{t("stock.fields.bin")}</th>
                {d.showCosts && <th className={thEnd}>{t("stock.fields.unitCost")}</th>}
                <th className={th}>{t("stock.fields.reason")}</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-line">
              {d.lines.map((l) => (
                <tr key={l.id} className="align-top">
                  <td className="px-4 py-2.5 tabular-nums text-fg-subtle">{l.lineNo}</td>
                  <td className="px-4 py-2.5">
                    <bdi className="font-mono font-semibold">{l.product.sku}</bdi> <span>{nameOf(l.product, t)}</span>
                    {l.serials.length > 0 && (
                      <span className="mt-1 block font-mono text-xs text-fg-subtle" dir="ltr">
                        {l.serials.join(", ")}
                      </span>
                    )}
                  </td>
                  {d.type === "ADJUSTMENT" && <td className="px-4 py-2.5">{l.direction ? t.dyn(`enums.adjustDirection.${l.direction}`) : "—"}</td>}
                  <td className="px-4 py-2.5 text-end tabular-nums">
                    {formatQuantity(l.quantity, L)} <span className="text-xs text-fg-subtle">{l.product.unit.code}</span>
                  </td>
                  <td className="px-4 py-2.5 font-mono text-fg-muted">
                    <bdi>{[l.fromBin?.code, l.toBin?.code].filter(Boolean).join(" → ") || "—"}</bdi>
                  </td>
                  {d.showCosts && <td className="px-4 py-2.5 text-end tabular-nums">{l.unitCost === null ? "—" : money(l.unitCost, L)}</td>}
                  <td className="px-4 py-2.5 text-fg-muted" dir="auto">
                    {l.reason ?? "—"}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>
      <Card className="overflow-hidden">
        <CardHeader title={t("stock.detail.movements")} />
        {d.movements.length === 0 ? (
          <p className="px-5 py-4 text-sm text-fg-muted">{t("stock.detail.noMovements")}</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[640px] text-sm">
              <thead className={tableHead}>
                <tr>
                  <th className={th}>{t("stock.fields.movementType")}</th>
                  <th className={th}>{t("stock.fields.sku")}</th>
                  <th className={th}>{t("stock.fields.warehouse")}</th>
                  <th className={thEnd}>{t("stock.fields.quantity")}</th>
                  <th className={thEnd}>{t("stock.fields.balanceAfter")}</th>
                  {d.showCosts && <th className={thEnd}>{t("stock.fields.unitCost")}</th>}
                  <th className={th}>{t("stock.fields.postedAt")}</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-line">
                {d.movements.map((m) => (
                  <tr key={m.id}>
                    <td className="px-4 py-2.5">{t.dyn(`enums.movementType.${m.type}`)}</td>
                    <td className="px-4 py-2.5 font-mono">
                      <bdi>{m.sku}</bdi>
                    </td>
                    <td className="px-4 py-2.5 font-mono">
                      <bdi>{m.bin ? `${m.warehouse} / ${m.bin}` : m.warehouse}</bdi>
                    </td>
                    <td className="px-4 py-2.5 text-end">
                      <SignedQty value={m.quantity} text={formatQuantity(m.quantity, L)} />
                    </td>
                    <td className="px-4 py-2.5 text-end tabular-nums">{formatQuantity(m.balanceAfter, L)}</td>
                    {d.showCosts && <td className="px-4 py-2.5 text-end tabular-nums">{money(m.unitCost, L)}</td>}
                    <td className="whitespace-nowrap px-4 py-2.5 text-fg-muted">{dateTime(m.createdAt, tz, L)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </>
  );
}
