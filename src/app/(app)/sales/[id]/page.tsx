import Link from "next/link";
import type { Metadata } from "next";
import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { BackArrow, Badge, DefinitionList, PageHeader } from "@/components/ui/misc";
import { SaleActions } from "@/components/sales/sale-actions";
import { SaleForm } from "@/components/sales/sale-form";
import { nameOf, tableHead, th, thEnd } from "@/components/erp/labels";
import { getT } from "@/i18n/server";
import { money } from "@/lib/constants";
import { formatQuantity } from "@/lib/inventory";
import { fmt, formatKey, todayKey } from "@/lib/time";
import { hasPermission } from "@/server/access";
import { requirePagePermission } from "@/server/auth/session";
import { getSale, saleWarehouses } from "@/server/services/sales";
import { loadOr404 } from "../../appointments/[id]/load";
import { saleStatusTone as statusTone } from "@/components/sales/labels";

export async function generateMetadata(): Promise<Metadata> {
  return { title: (await getT())("sales.title") };
}

export default async function SalePage({ params }: { params: Promise<{ id: string }> }) {
  const [user, t] = await Promise.all([requirePagePermission("sales.view"), getT()]);
  const { id } = await params;
  const s = await loadOr404(() => getSale(user, id));
  const L = t.locale;
  const tz = user.settings.timezone;
  const when = (iso: string | null) => (iso ? fmt(new Date(iso), tz, "d MMM yyyy, HH:mm", L) : "");
  const warehouses = s.can.edit ? await saleWarehouses(user) : [];
  const margin = s.can.seeCosts ? s.lines.reduce((m, l) => m + (l.unitCost === null ? 0 : l.lineTotal - l.unitCost * l.quantity), 0) : null;
  return (
    <>
      <PageHeader
        breadcrumb={
          <Link href="/sales" className="hover:text-fg">
            <BackArrow /> {t("sales.title")}
          </Link>
        }
        title={
          <span className="flex flex-wrap items-center gap-3">
            <bdi className="font-mono">{s.number}</bdi>
            <Badge className={statusTone[s.status]}>{t(`sales.statuses.${s.status}`)}</Badge>
          </span>
        }
        description={<span dir="auto">{s.customerName}</span>}
        actions={<SaleActions id={s.id} version={s.version} can={s.can} warehouseLabel={`${s.warehouse.code} · ${nameOf(s.warehouse, t)}`} />}
      />
      <div className="grid grid-cols-1 gap-6 lg:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]">
        <Card className="overflow-hidden">
          <CardHeader title={t("sales.lines")} />
          <div className="overflow-x-auto">
            <table className="w-full min-w-[560px] text-sm">
              <thead className={tableHead}>
                <tr>
                  <th className={th}>{t("stock.fields.product")}</th>
                  <th className={thEnd}>{t("sales.quantity")}</th>
                  <th className={thEnd}>{t("sales.unitPrice")}</th>
                  <th className={thEnd}>{t("sales.discount")}</th>
                  <th className={thEnd}>{t("sales.lineTotal")}</th>
                  {s.can.seeCosts && <th className={thEnd}>{t("sales.cost")}</th>}
                </tr>
              </thead>
              <tbody className="divide-y divide-line">
                {s.lines.map((l) => (
                  <tr key={l.id}>
                    <td className="px-4 py-2">
                      <Link prefetch={false} href={`/products/${l.product.id}`} className="font-mono font-semibold text-brand-text hover:underline">
                        {l.product.sku}
                      </Link>{" "}
                      {nameOf(l.product, t)}
                      {l.serials.length > 0 && (
                        <span className="block font-mono text-xs text-fg-subtle" dir="ltr">
                          {l.serials.join(", ")}
                        </span>
                      )}
                    </td>
                    <td className="px-4 py-2 text-end tabular-nums">
                      {formatQuantity(l.quantity, L)} <span className="text-xs text-fg-subtle">{l.product.unit.code}</span>
                    </td>
                    <td className="px-4 py-2 text-end tabular-nums">{money(l.unitPrice, L)}</td>
                    <td className="px-4 py-2 text-end tabular-nums">{l.discount ? money(l.discount, L) : "—"}</td>
                    <td className="px-4 py-2 text-end tabular-nums font-medium">{money(l.lineTotal, L)}</td>
                    {s.can.seeCosts && <td className="px-4 py-2 text-end tabular-nums text-fg-muted">{l.unitCost === null ? "—" : money(l.unitCost * l.quantity, L)}</td>}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <dl className="grid grid-cols-2 gap-2 border-t border-line bg-surface-muted/50 px-5 py-4 text-sm sm:grid-cols-4">
            <div>
              <dt className="text-fg-muted">{t("sales.subtotal")}</dt>
              <dd className="tabular-nums">{money(s.subtotal, L)}</dd>
            </div>
            <div>
              <dt className="text-fg-muted">{t("sales.discountTotal")}</dt>
              <dd className="tabular-nums">{money(s.discountTotal, L)}</dd>
            </div>
            <div>
              <dt className="text-fg-muted">{t("sales.total")}</dt>
              <dd className="text-lg font-semibold tabular-nums">{money(s.total, L)}</dd>
            </div>
            {margin !== null && s.status === "CONFIRMED" && (
              <div>
                <dt className="text-fg-muted">{t("sales.margin")}</dt>
                <dd className="tabular-nums">{money(margin, L)}</dd>
              </div>
            )}
          </dl>
        </Card>
        <Card>
          <CardHeader title={t("common.details")} />
          <CardBody>
            <DefinitionList
              items={[
                { label: t("sales.date"), value: formatKey(s.invoiceDate, { day: "numeric", month: "long", year: "numeric" }, L) },
                { label: t("sales.customer"), value: s.customer && hasPermission(user, "customers.view") ? <Link href={`/customers/${s.customer.id}`} className="text-brand-text hover:underline" dir="auto">{s.customerName}</Link> : <span dir="auto">{s.customerName}</span> },
                { label: t("sales.phone"), value: s.customerPhone && <span dir="ltr">{s.customerPhone}</span> },
                { label: t("sales.warehouse"), value: `${s.warehouse.code} · ${nameOf(s.warehouse, t)}` },
                { label: t("sales.payment"), value: s.paymentMethod && t.dyn(`enums.paymentMethod.${s.paymentMethod}`) },
                { label: t("docLinks.visit"), value: s.appointment && <Link href={`/appointments/${s.appointment.id}`} className="font-mono text-brand-text hover:underline">{s.appointment.code}</Link> },
                { label: t("sales.stockDocument"), value: s.stockDocument && <Link href={`/stock/documents/${s.stockDocument.id}`} className="font-mono text-brand-text hover:underline">{s.stockDocument.number}</Link> },
                { label: t("sales.note"), value: s.note && <span dir="auto">{s.note}</span>, full: true },
              ]}
            />
            <ul className="mt-4 space-y-1 text-xs text-fg-muted">
              <li>{t("sales.createdBy", { name: s.createdBy.name })}</li>
              {s.confirmedBy && <li>{t("sales.confirmedBy", { name: s.confirmedBy.name, when: when(s.confirmedAt) })}</li>}
              {s.cancelledBy && <li>{t("sales.cancelledBy", { name: s.cancelledBy.name, when: when(s.cancelledAt), reason: s.cancelReason ?? "" })}</li>}
            </ul>
          </CardBody>
        </Card>
      </div>
      {s.can.edit && (
        <div className="mt-6 max-w-5xl">
          <h2 className="mb-3 text-base font-semibold">{t("sales.edit")}</h2>
          <SaleForm
            warehouses={warehouses}
            today={todayKey(tz)}
            timezone={tz}
            showStock={hasPermission(user, "inventory.view")}
            initial={{
              id: s.id,
              version: s.version,
              invoiceDate: s.invoiceDate,
              customer: s.customer,
              customerName: s.customerName,
              customerPhone: s.customerPhone,
              appointmentRef: s.appointment?.code ?? null,
              warehouseId: s.warehouse.id,
              paymentMethod: s.paymentMethod,
              note: s.note,
              lines: s.lines.map((l) => ({ product: { ...l.product, unit: { code: l.product.unit.code, allowsFraction: l.product.unit.allowsFraction } }, quantity: l.quantity, unitPrice: l.unitPrice, discount: l.discount, serials: l.serials })),
            }}
          />
        </div>
      )}
    </>
  );
}
