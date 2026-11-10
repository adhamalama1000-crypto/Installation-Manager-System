"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Plus, Trash2 } from "lucide-react";
import type { PaymentMethod } from "@prisma/client";
import { Button } from "@/components/ui/button";
import { Card, CardHeader } from "@/components/ui/card";
import { Combobox, type ComboOption } from "@/components/ui/combobox";
import { Dialog } from "@/components/ui/dialog";
import { DraftBanner } from "@/components/ui/draft-banner";
import { Field, Input, Select, Textarea } from "@/components/ui/field";
import { ProductPicker, type PickedProduct } from "@/components/erp/document-form";
import { nameOf } from "@/components/erp/labels";
import { requestId, useAction } from "@/components/erp/use-action";
import { useT } from "@/i18n/client";
import { api } from "@/lib/api-client";
import { money, parseSerials, PAYMENT_METHODS } from "@/lib/constants";
import { invoiceTotals, lineTotal } from "@/lib/sales";
import { recallChoice, rememberChoice, useDraft } from "@/lib/use-draft";

type Warehouse = { id: string; code: string; nameEn: string; nameAr: string };
type Product = PickedProduct & { sellingPrice?: number | null };
type Line = { key: string; product: Product | null; quantity: string; unitPrice: string; discount: string; serials: string };
export type SaleInitial = {
  id: string;
  version: number;
  invoiceDate: string;
  customer: { id: string; name: string } | null;
  customerName: string;
  customerPhone: string | null;
  appointmentRef: string | null;
  warehouseId: string;
  paymentMethod: PaymentMethod | null;
  note: string | null;
  lines: { product: Product; quantity: number; unitPrice: number; discount: number; serials: string[] }[];
};

let seq = 0;
const newKey = () => `s${++seq}`;
const blankLine = (): Line => ({ key: newKey(), product: null, quantity: "1", unitPrice: "", discount: "", serials: "" });
const toNum = (s: string) => {
  const n = Number(s.replace(/[,\s]/g, ""));
  return Number.isFinite(n) ? n : 0;
};
const takesSerials = (p: Product | null) => !!p && (p.trackSerials || !!p.serialsOptional);

/** Prepare a sale: pick the customer and products, prices come from the catalogue, totals update as you type. */
export function SaleForm({ warehouses, today, timezone, initial, showStock }: { warehouses: Warehouse[]; today: string; timezone: string; initial?: SaleInitial; showStock: boolean }) {
  const t = useT();
  const router = useRouter();
  const { busy, errors, run } = useAction();
  const clientRequestId = useRef(requestId());
  const [h, setH] = useState(() => ({
    invoiceDate: initial?.invoiceDate ?? today,
    customerName: initial?.customer ? "" : (initial?.customerName ?? ""),
    customerPhone: initial?.customerPhone ?? "",
    appointmentRef: initial?.appointmentRef ?? "",
    warehouseId: initial?.warehouseId ?? (warehouses.length === 1 ? warehouses[0]!.id : ""),
    paymentMethod: (initial?.paymentMethod ?? "CASH") as PaymentMethod | "",
    note: initial?.note ?? "",
  }));
  const [customer, setCustomer] = useState<{ id: string; label: string } | null>(initial?.customer ? { id: initial.customer.id, label: initial.customer.name } : null);
  const [lines, setLines] = useState<Line[]>(() =>
    initial?.lines.length
      ? initial.lines.map((l) => ({ key: newKey(), product: l.product, quantity: String(l.quantity), unitPrice: String(l.unitPrice), discount: l.discount ? String(l.discount) : "", serials: l.serials.join("\n") }))
      : [blankLine()],
  );
  const [confirmOpen, setConfirmOpen] = useState(false);
  const draft = useDraft("sale:new", { h, customer, lines }, { enabled: !initial, dirty: lines.some((l) => l.product) || !!customer || !!h.customerName });
  // The warehouse used last, on a new sale (browser storage, so after mounting).
  useEffect(() => {
    if (initial) return;
    const w = recallChoice("sale.warehouse");
    // eslint-disable-next-line react-hooks/set-state-in-effect -- reading browser storage once after mount
    if (w && warehouses.some((x) => x.id === w)) setH((x) => (x.warehouseId ? x : { ...x, warehouseId: w }));
  }, [initial, warehouses]);

  const loadCustomers = async (q: string, signal: AbortSignal): Promise<ComboOption[]> =>
    (await api<{ customers: { id: string; name: string; phone: string }[] }>(`/api/customers/lookup?${new URLSearchParams({ q })}`, { signal })).customers.map((c) => ({ id: c.id, label: c.name, hint: c.phone, keywords: c.phone }));

  const totals = useMemo(() => invoiceTotals(lines.filter((l) => l.product).map((l) => ({ quantity: toNum(l.quantity), unitPrice: toNum(l.unitPrice), discount: toNum(l.discount) }))), [lines]);
  const update = (key: string, patch: Partial<Line>) => setLines((ls) => ls.map((l) => (l.key === key ? { ...l, ...patch } : l)));
  const lineErr = (i: number, f: string) => errors[`lines.${i}.${f}`];
  const warehouse = warehouses.find((w) => w.id === h.warehouseId);

  async function submit(confirm: boolean) {
    const filled = lines.filter((l) => l.product);
    const body = {
      invoiceDate: h.invoiceDate,
      customerId: customer?.id ?? null,
      customerName: customer ? null : h.customerName,
      customerPhone: h.customerPhone,
      appointmentRef: h.appointmentRef,
      warehouseId: h.warehouseId,
      paymentMethod: h.paymentMethod || null,
      note: h.note,
      confirm,
      ...(initial ? { version: initial.version } : { clientRequestId: clientRequestId.current }),
      lines: filled.map((l) => ({ productId: l.product!.id, quantity: l.quantity, unitPrice: l.unitPrice, discount: l.discount, serials: l.serials })),
    };
    const r = await run(
      () => (initial ? api<{ sale: { id: string; number: string } }>(`/api/sales/${initial.id}`, { method: "PATCH", body }) : api<{ sale: { id: string; number: string } }>("/api/sales", { method: "POST", body })),
      (res) => (confirm ? t("sales.confirmed") : t("sales.created", { number: res.sale.number })),
      { refresh: !!initial },
    );
    setConfirmOpen(false);
    if (!r) return;
    draft.clear();
    rememberChoice("sale.warehouse", h.warehouseId);
    router.push(`/sales/${r.sale.id}`);
  }

  return (
    <form
      className="space-y-6"
      noValidate
      onSubmit={(e) => {
        e.preventDefault();
        void submit(false);
      }}
    >
      {draft.saved && (
        <DraftBanner
          at={draft.saved.at}
          timezone={timezone}
          onRestore={() => {
            const v = draft.saved!.values as { h: typeof h; customer: typeof customer; lines: Line[] };
            setH(v.h);
            setCustomer(v.customer);
            setLines(v.lines.map((l) => ({ ...l, key: newKey() })));
            draft.dismiss();
          }}
          onDiscard={draft.clear}
        />
      )}
      <Card>
        <CardHeader title={t("common.details")} />
        <div className="grid grid-cols-1 gap-4 p-5 sm:grid-cols-2 lg:grid-cols-3">
          <Field label={t("sales.customer")} hint={t("sales.customerHint")} error={errors.customerId}>
            {(p) => (
              <Combobox
                id={p.id}
                label={t("sales.customer")}
                load={loadCustomers}
                minChars={2}
                value={customer?.id ?? null}
                selectedLabel={customer?.label}
                onChange={(id, o) => {
                  setCustomer(id && o ? { id, label: o.label } : null);
                  if (o?.hint) setH((x) => ({ ...x, customerPhone: o.hint ?? x.customerPhone }));
                }}
                allowClear
                invalid={!!p["aria-invalid"]}
              />
            )}
          </Field>
          {!customer && (
            <Field label={t("sales.walkIn")} required error={errors.customerName}>
              {(p) => <Input {...p} value={h.customerName} onChange={(e) => setH({ ...h, customerName: e.target.value })} maxLength={200} dir="auto" />}
            </Field>
          )}
          <Field label={t("sales.phone")} error={errors.customerPhone}>
            {(p) => <Input {...p} value={h.customerPhone} onChange={(e) => setH({ ...h, customerPhone: e.target.value })} type="tel" inputMode="tel" dir="ltr" />}
          </Field>
          <Field label={t("sales.warehouse")} required error={errors.warehouseId}>
            {(p) => (
              <Select {...p} value={h.warehouseId} onChange={(e) => setH({ ...h, warehouseId: e.target.value })}>
                <option value="">{t("common.choose")}</option>
                {warehouses.map((w) => (
                  <option key={w.id} value={w.id}>
                    {w.code} · {nameOf(w, t)}
                  </option>
                ))}
              </Select>
            )}
          </Field>
          <Field label={t("sales.date")} required error={errors.invoiceDate}>
            {(p) => <Input {...p} type="date" max={today} value={h.invoiceDate} onChange={(e) => setH({ ...h, invoiceDate: e.target.value })} />}
          </Field>
          <Field label={t("sales.payment")} error={errors.paymentMethod}>
            {(p) => (
              <Select {...p} value={h.paymentMethod} onChange={(e) => setH({ ...h, paymentMethod: e.target.value as PaymentMethod | "" })}>
                <option value="">{t("common.notSpecified")}</option>
                {PAYMENT_METHODS.map((m) => (
                  <option key={m} value={m}>
                    {t.dyn(`enums.paymentMethod.${m}`)}
                  </option>
                ))}
              </Select>
            )}
          </Field>
          <Field label={t("sales.visit")} hint={t("docLinks.visitHint")} error={errors.appointmentRef}>
            {(p) => <Input {...p} value={h.appointmentRef} onChange={(e) => setH({ ...h, appointmentRef: e.target.value })} maxLength={20} dir="ltr" className="font-mono" placeholder="APT-000123" />}
          </Field>
          <Field label={t("sales.note")} error={errors.note} className="sm:col-span-2">
            {(p) => <Textarea {...p} value={h.note} onChange={(e) => setH({ ...h, note: e.target.value })} rows={1} maxLength={1000} dir="auto" />}
          </Field>
        </div>
      </Card>

      <Card>
        <CardHeader
          title={t("sales.lines")}
          actions={
            <Button type="button" size="sm" variant="outline" onClick={() => setLines((ls) => [...ls, blankLine()])}>
              <Plus className="h-4 w-4" /> {t("stock.form.addLine")}
            </Button>
          }
        />
        <ol className="divide-y divide-line">
          {lines.map((l, i) => {
            const label = t("sales.line", { n: i + 1 });
            const total = l.product ? lineTotal({ quantity: toNum(l.quantity), unitPrice: toNum(l.unitPrice), discount: toNum(l.discount) }) : 0;
            return (
              <li key={l.key} className="space-y-3 p-5">
                <div className="flex items-start gap-3">
                  <div className="min-w-0 flex-1">
                    {l.product ? (
                      <div className="flex flex-wrap items-center gap-2 text-sm">
                        <bdi className="font-mono font-semibold">{l.product.sku}</bdi> <span>{nameOf(l.product, t)}</span>
                        <button type="button" className="text-xs text-brand-text hover:underline" onClick={() => update(l.key, { product: null })}>
                          {t("stock.form.change")}
                        </button>
                      </div>
                    ) : (
                      <ProductPicker
                        label={label}
                        warehouseId={showStock ? h.warehouseId : ""}
                        error={lineErr(i, "productId")}
                        onPick={(p) => {
                          const prod = p as Product;
                          update(l.key, { product: prod, unitPrice: prod.sellingPrice != null ? String(prod.sellingPrice) : l.unitPrice });
                          // A new empty line is ready for the next item.
                          if (i === lines.length - 1) setLines((ls) => [...ls, blankLine()]);
                        }}
                      />
                    )}
                  </div>
                  <button type="button" className="rounded p-2 text-fg-subtle hover:bg-surface-muted hover:text-danger" aria-label={`${t("common.delete")} ${label}`} onClick={() => setLines((ls) => (ls.length > 1 ? ls.filter((x) => x.key !== l.key) : [blankLine()]))}>
                    <Trash2 className="h-4 w-4" />
                  </button>
                </div>
                {l.product && (
                  <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
                    <Field label={`${t("sales.quantity")} (${l.product.unit.code})`} error={lineErr(i, "quantity")}>
                      {(p) => <Input {...p} value={l.quantity} onChange={(e) => update(l.key, { quantity: e.target.value })} inputMode="decimal" dir="ltr" />}
                    </Field>
                    <Field label={t("sales.unitPrice")} error={lineErr(i, "unitPrice")}>
                      {(p) => <Input {...p} value={l.unitPrice} onChange={(e) => update(l.key, { unitPrice: e.target.value })} inputMode="decimal" dir="ltr" />}
                    </Field>
                    <Field label={t("sales.discount")} error={lineErr(i, "discount")}>
                      {(p) => <Input {...p} value={l.discount} onChange={(e) => update(l.key, { discount: e.target.value })} inputMode="decimal" dir="ltr" />}
                    </Field>
                    <div className="flex flex-col gap-1.5">
                      <span className="text-sm font-medium">{t("sales.lineTotal")}</span>
                      <span className="flex h-10 items-center tabular-nums font-semibold">{money(total, t.locale)}</span>
                    </div>
                    {takesSerials(l.product) && (
                      <Field
                        label={t("sales.serials")}
                        required={l.product.trackSerials}
                        hint={t("stock.form.serialsCount", { given: parseSerials(l.serials).length, count: toNum(l.quantity) })}
                        error={lineErr(i, "serials")}
                        className="col-span-2 sm:col-span-4"
                      >
                        {(p) => <Textarea {...p} value={l.serials} onChange={(e) => update(l.key, { serials: e.target.value })} rows={2} dir="ltr" className="font-mono" />}
                      </Field>
                    )}
                  </div>
                )}
              </li>
            );
          })}
        </ol>
        <dl className="grid grid-cols-3 gap-2 border-t border-line bg-surface-muted/50 px-5 py-4 text-sm">
          <div>
            <dt className="text-fg-muted">{t("sales.subtotal")}</dt>
            <dd className="tabular-nums font-medium">{money(totals.subtotal, t.locale)}</dd>
          </div>
          <div>
            <dt className="text-fg-muted">{t("sales.discountTotal")}</dt>
            <dd className="tabular-nums font-medium">{money(totals.discountTotal, t.locale)}</dd>
          </div>
          <div>
            <dt className="text-fg-muted">{t("sales.total")}</dt>
            <dd className="text-lg tabular-nums font-semibold" data-testid="sale-total">
              {money(totals.total, t.locale)}
            </dd>
          </div>
        </dl>
      </Card>

      {errors._form && (
        <p className="text-sm font-medium text-danger" role="alert">
          {t.msg(errors._form)}
        </p>
      )}
      <div className="flex flex-wrap justify-end gap-2">
        <Button type="submit" variant="outline" loading={busy}>
          {t("sales.saveDraft")}
        </Button>
        <Button type="button" loading={busy} onClick={() => setConfirmOpen(true)} disabled={!lines.some((l) => l.product)}>
          {t("sales.saveConfirm")}
        </Button>
      </div>
      <Dialog
        open={confirmOpen}
        onClose={() => setConfirmOpen(false)}
        title={t("sales.confirmTitle")}
        description={t("sales.confirmText", { warehouse: warehouse ? `${warehouse.code} · ${nameOf(warehouse, t)}` : "—" })}
        size="sm"
        footer={
          <>
            <Button variant="outline" onClick={() => setConfirmOpen(false)}>
              {t("common.cancel")}
            </Button>
            <Button loading={busy} onClick={() => void submit(true)}>
              {t("sales.confirm")}
            </Button>
          </>
        }
      >
        <p className="text-sm">
          {t("sales.total")}: <span className="font-semibold tabular-nums">{money(totals.total, t.locale)}</span>
        </p>
      </Dialog>
    </form>
  );
}
