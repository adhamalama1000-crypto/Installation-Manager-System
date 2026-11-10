"use client";

import { useEffect, useId, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Plus, Trash2 } from "lucide-react";
import type { AdjustDirection, StockDocType, StockReturnKind } from "@prisma/client";
import { Button } from "@/components/ui/button";
import { Card, CardHeader } from "@/components/ui/card";
import { Combobox, type ComboOption } from "@/components/ui/combobox";
import { Field, Input, Select, Textarea } from "@/components/ui/field";
import { useT } from "@/i18n/client";
import { api } from "@/lib/api-client";
import { parseSerials } from "@/lib/constants";
import { ADJUST_DIRECTIONS, docWarehouseSides, formatQuantity, lineTakesCost } from "@/lib/inventory";
import { cn } from "@/lib/utils";
import { ConfirmButton } from "./confirm-dialog";
import { docTypeLabel, nameOf } from "./labels";
import { requestId, useAction } from "./use-action";

export type FormWarehouse = { id: string; code: string; nameEn: string; nameAr: string; kind: string; bins: { id: string; code: string; name: string | null }[] };
export type PickedProduct = { id: string; sku: string; nameEn: string; nameAr: string; trackSerials: boolean; serialsOptional?: boolean; serialMode?: "NONE" | "OPTIONAL" | "REQUIRED"; unit: { code: string; allowsFraction: boolean } };
/** Serials are entered for mandatory and optional serial products. */
const takesSerials = (p: PickedProduct | null | undefined) => !!p && (p.trackSerials || p.serialsOptional || p.serialMode === "OPTIONAL");
const optionalSerials = (p: PickedProduct | null | undefined) => !!p && !p.trackSerials && (p.serialsOptional || p.serialMode === "OPTIONAL");
export type DocLineInitial = {
  product: PickedProduct;
  quantity: number;
  unitCost: number | null;
  fromBinId: string | null;
  toBinId: string | null;
  direction: AdjustDirection | null;
  serials: string[];
  reason: string | null;
};
export type DocInitial = {
  id: string;
  number: string;
  version: number;
  fromWarehouseId: string | null;
  toWarehouseId: string | null;
  documentDate: string;
  reference: string | null;
  counterparty: string | null;
  note: string | null;
  supplier?: { id: string; label: string } | null;
  appointmentRef?: string | null;
  lines: DocLineInitial[];
};

type Line = {
  key: string;
  product: PickedProduct | null;
  quantity: string;
  unitCost: string;
  fromBinId: string;
  toBinId: string;
  direction: AdjustDirection | "";
  serials: string;
  reason: string;
};

let seq = 0;
const newKey = () => `l${++seq}`;
const blankLine = (type: StockDocType): Line => ({ key: newKey(), product: null, quantity: "", unitCost: "", fromBinId: "", toBinId: "", direction: type === "ADJUSTMENT" ? "" : "", serials: "", reason: "" });

/** Finds an active product by SKU, barcode or name, with its quantity at a warehouse. */
export function ProductPicker({ warehouseId, onPick, error, label }: { warehouseId: string; onPick: (p: PickedProduct) => void; error?: string; label: string }) {
  const t = useT();
  const id = useId();
  const [q, setQ] = useState("");
  // Results show while the search box is in use; Escape or leaving it closes them.
  const [open, setOpen] = useState(false);
  // The last answer and the search it answers; anything else on screen is "searching".
  const [result, setResult] = useState<{ term: string; rows: (PickedProduct & { onHand: number })[] } | null>(null);
  const term = q.trim();
  useEffect(() => {
    if (term.length < 2) return;
    const ctl = new AbortController();
    const timer = setTimeout(() => {
      const p = new URLSearchParams({ q: term, pageSize: "8", sort: "sku" });
      if (warehouseId) p.set("warehouseId", warehouseId);
      api<{ rows: (PickedProduct & { onHand: number })[] }>(`/api/products?${p}`, { signal: ctl.signal })
        .then((r) => setResult({ term, rows: r.rows }))
        .catch(() => {
          if (!ctl.signal.aborted) setResult({ term, rows: [] });
        });
    }, 250);
    return () => {
      clearTimeout(timer);
      ctl.abort();
    };
  }, [term, warehouseId]);
  const active = open && term.length >= 2;
  const state = { loading: active && result?.term !== term, rows: active && result?.term === term ? result.rows : null };
  return (
    <div
      className="relative"
      onBlur={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setOpen(false);
      }}
    >
      <label htmlFor={id} className="sr-only">
        {label}
      </label>
      <Input
        id={id}
        value={q}
        onChange={(e) => {
          setQ(e.target.value);
          setOpen(true);
        }}
        onFocus={() => setOpen(true)}
        onKeyDown={(e) => {
          if (e.key === "Escape" && open) {
            e.preventDefault();
            setOpen(false);
          }
        }}
        placeholder={t("stock.form.productSearch")}
        aria-invalid={error ? true : undefined}
        aria-expanded={active}
        autoComplete="off"
        dir="auto"
      />
      {error && (
        <p className="mt-1 text-xs font-medium text-danger" role="alert">
          {t.msg(error)}
        </p>
      )}
      {(state.loading || state.rows) && (
        <div className="absolute inset-x-0 top-full z-20 mt-1 max-h-72 overflow-y-auto rounded-lg border border-line bg-surface shadow-pop">
          {state.loading ? (
            <p className="px-3 py-2 text-sm text-fg-muted" role="status">
              {t("stock.form.searching")}
            </p>
          ) : state.rows && state.rows.length === 0 ? (
            <p className="px-3 py-2 text-sm text-fg-muted">{t("stock.form.noProductFound")}</p>
          ) : (
            <ul role="listbox" aria-label={label}>
              {state.rows!.map((p) => (
                <li key={p.id} role="option" aria-selected={false}>
                  <button
                    type="button"
                    className="flex w-full items-center gap-3 px-3 py-2 text-start text-sm hover:bg-surface-muted"
                    // Keep the focus in the search box, so the list does not close before the click lands.
                    onMouseDown={(e) => e.preventDefault()}
                    onClick={() => {
                      onPick(p);
                      setQ("");
                    }}
                  >
                    <bdi className="font-mono font-semibold text-fg">{p.sku}</bdi>
                    <span className="min-w-0 flex-1 truncate text-fg">{nameOf(p, t)}</span>
                    {warehouseId && (
                      <span className="shrink-0 tabular-nums text-xs text-fg-subtle">
                        {formatQuantity(p.onHand, t.locale)} {p.unit.code}
                      </span>
                    )}
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}

/** What is at the warehouse now, per bin (shown under a line once the product is chosen). */
function Availability({ productId, warehouse }: { productId: string; warehouse: FormWarehouse }) {
  const t = useT();
  const [data, setData] = useState<{ total: number; bins: { code: string | null; quantity: number }[] } | null>(null);
  useEffect(() => {
    const ctl = new AbortController();
    api<{ total: number; bins: { code: string | null; quantity: number }[] }>(`/api/inventory/availability?productId=${productId}&warehouseId=${warehouse.id}`, { signal: ctl.signal })
      .then(setData)
      .catch(() => setData(null));
    return () => ctl.abort();
  }, [productId, warehouse.id]);
  if (!data) return null;
  const parts = data.bins.filter((b) => b.quantity !== 0).map((b) => `${b.code ?? t("stock.noBin")}: ${formatQuantity(b.quantity, t.locale)}`);
  return (
    <p className="text-xs text-fg-subtle">
      {t("stock.form.availableHere", { location: warehouse.code, qty: formatQuantity(data.total, t.locale) })}
      {parts.length > 1 && ` (${parts.join(" · ")})`}
    </p>
  );
}

export function DocumentForm({
  type,
  returnKind,
  warehouses,
  initial,
  canPost,
  showCosts,
  today,
}: {
  type: StockDocType;
  returnKind: StockReturnKind | null;
  warehouses: FormWarehouse[];
  initial?: DocInitial;
  canPost: boolean;
  showCosts: boolean;
  today: string;
}) {
  const t = useT();
  const router = useRouter();
  const { busy, errors, run } = useAction();
  const clientRequestId = useRef(requestId());
  const sides = docWarehouseSides(type, returnKind);
  const [h, setH] = useState({
    fromWarehouseId: initial?.fromWarehouseId ?? "",
    toWarehouseId: initial?.toWarehouseId ?? "",
    documentDate: initial?.documentDate ?? today,
    reference: initial?.reference ?? "",
    counterparty: initial?.counterparty ?? "",
    note: initial?.note ?? "",
    appointmentRef: initial?.appointmentRef ?? "",
  });
  const [supplier, setSupplier] = useState<{ id: string; label: string } | null>(initial?.supplier ?? null);
  const supplierSide = type === "RECEIPT" || (type === "RETURN" && returnKind === "SUPPLIER");
  const visitSide = type === "ISSUE" || type === "RETURN";
  const loadSuppliers = async (q: string, signal: AbortSignal): Promise<ComboOption[]> =>
    (await api<{ rows: { id: string; code: string; name: string; nameAr: string | null; phone: string | null }[] }>(`/api/suppliers/options?${new URLSearchParams({ q })}`, { signal })).rows.map((r) => ({
      id: r.id,
      label: t.locale === "ar" && r.nameAr ? r.nameAr : r.name,
      hint: r.code,
      keywords: `${r.name} ${r.nameAr ?? ""} ${r.phone ?? ""}`,
    }));
  const [lines, setLines] = useState<Line[]>(() =>
    initial?.lines.length
      ? initial.lines.map((l) => ({
          key: newKey(),
          product: l.product,
          quantity: String(l.quantity),
          unitCost: l.unitCost === null ? "" : String(l.unitCost),
          fromBinId: l.fromBinId ?? "",
          // An adjustment keeps its bin in one field whichever way it goes.
          toBinId: (type === "ADJUSTMENT" ? (l.toBinId ?? l.fromBinId) : l.toBinId) ?? "",
          direction: l.direction ?? "",
          serials: l.serials.join("\n"),
          reason: l.reason ?? "",
        }))
      : [blankLine(type)],
  );
  const byId = useMemo(() => new Map(warehouses.map((w) => [w.id, w])), [warehouses]);
  const from = byId.get(h.fromWarehouseId);
  const to = byId.get(h.toWarehouseId);
  // Availability is shown where the stock is taken from (or, for stock coming in, where it goes).
  const availAt = sides.from ? from : to;
  const typeLabel = docTypeLabel(t, type, returnKind);
  const update = (key: string, patch: Partial<Line>) => setLines((ls) => ls.map((l) => (l.key === key ? { ...l, ...patch } : l)));
  const lineErr = (i: number, f: string) => errors[`lines.${i}.${f}`];

  function body(post: boolean) {
    return {
      type,
      returnKind,
      fromWarehouseId: sides.from ? h.fromWarehouseId : null,
      toWarehouseId: sides.to ? h.toWarehouseId : null,
      documentDate: h.documentDate,
      reference: h.reference,
      counterparty: h.counterparty,
      note: h.note,
      supplierId: supplierSide ? (supplier?.id ?? null) : null,
      appointmentRef: visitSide ? h.appointmentRef : null,
      post,
      ...(initial ? { version: initial.version } : { clientRequestId: clientRequestId.current }),
      lines: lines
        .filter((l) => l.product || l.quantity)
        .map((l) => ({
          productId: l.product?.id ?? "",
          quantity: l.quantity,
          unitCost: lineTakesCost(type, returnKind, l.direction || null) ? l.unitCost : "",
          fromBinId: sides.from ? l.fromBinId : "",
          toBinId: sides.to ? l.toBinId : "",
          direction: type === "ADJUSTMENT" ? l.direction : "",
          serials: takesSerials(l.product) ? l.serials : "",
          reason: l.reason,
        })),
    };
  }

  async function save(post: boolean): Promise<boolean> {
    const r = await run(
      () =>
        initial
          ? api<{ document: { id: string; number: string } }>(`/api/stock-documents/${initial.id}`, { method: "PATCH", body: body(post) })
          : api<{ document: { id: string; number: string } }>("/api/stock-documents", { method: "POST", body: body(post) }),
      (r) => (post ? t("stock.form.posted", { number: r.document.number }) : t("stock.form.savedDraft", { number: r.document.number })),
      { refresh: false },
    );
    if (!r) return false;
    router.push(`/stock/documents/${r.document.id}`);
    router.refresh();
    return true;
  }

  const warehouseSelect = (field: "fromWarehouseId" | "toWarehouseId", label: string) => (
    <Field label={label} required error={errors[field]}>
      {(p) => (
        <Select {...p} value={h[field]} onChange={(e) => setH({ ...h, [field]: e.target.value })}>
          <option value="">{t("common.choose")}</option>
          {warehouses.map((w) => (
            <option key={w.id} value={w.id}>
              {w.code} · {nameOf(w, t)}
            </option>
          ))}
        </Select>
      )}
    </Field>
  );
  const binSelect = (w: FormWarehouse | undefined, value: string, onChange: (v: string) => void, label: string, error?: string) =>
    w && w.bins.length > 0 ? (
      <Field label={label} error={error}>
        {(p) => (
          <Select {...p} value={value} onChange={(e) => onChange(e.target.value)}>
            <option value="">{t("stock.noBin")}</option>
            {w.bins.map((b) => (
              <option key={b.id} value={b.id}>
                {b.code}
                {b.name ? ` · ${b.name}` : ""}
              </option>
            ))}
          </Select>
        )}
      </Field>
    ) : null;

  return (
    <form
      noValidate
      onSubmit={(e) => {
        e.preventDefault();
        void save(false);
      }}
      className="space-y-6"
    >
      <Card>
        <CardHeader title={t("common.details")} description={initial ? typeLabel : t("stock.form.textNew")} />
        <div className="grid grid-cols-1 gap-4 p-5 sm:grid-cols-2 lg:grid-cols-3">
          {sides.from && warehouseSelect("fromWarehouseId", t("stock.fields.fromWarehouse"))}
          {sides.to && warehouseSelect("toWarehouseId", type === "ADJUSTMENT" ? t("stock.fields.warehouse") : t("stock.fields.toWarehouse"))}
          <Field label={t("stock.fields.documentDate")} required error={errors.documentDate}>
            {(p) => <Input {...p} type="date" max={today} value={h.documentDate} onChange={(e) => setH({ ...h, documentDate: e.target.value })} />}
          </Field>
          <Field label={t("stock.fields.reference")} hint={t("stock.fields.referenceHint")} error={errors.reference}>
            {(p) => <Input {...p} value={h.reference} onChange={(e) => setH({ ...h, reference: e.target.value })} maxLength={100} dir="auto" />}
          </Field>
          {supplierSide && (
            <Field label={t("suppliers.pick")} hint={t("suppliers.pickHint")} error={errors.supplierId}>
              {(p) => (
                <Combobox
                  id={p.id}
                  label={t("suppliers.pick")}
                  load={loadSuppliers}
                  minChars={0}
                  value={supplier?.id ?? null}
                  selectedLabel={supplier?.label}
                  onChange={(id, o) => {
                    setSupplier(id && o ? { id, label: o.label } : null);
                    if (o && !h.counterparty) setH((x) => ({ ...x, counterparty: o.label }));
                  }}
                  allowClear
                  invalid={!!p["aria-invalid"]}
                />
              )}
            </Field>
          )}
          {(type === "RECEIPT" || type === "RETURN" || type === "ISSUE") && (
            <Field label={type === "RECEIPT" || returnKind === "SUPPLIER" ? t("stock.fields.supplier") : t("stock.fields.customer")} error={errors.counterparty}>
              {(p) => <Input {...p} value={h.counterparty} onChange={(e) => setH({ ...h, counterparty: e.target.value })} maxLength={200} dir="auto" />}
            </Field>
          )}
          {visitSide && (
            <Field label={t("docLinks.visit")} hint={t("docLinks.visitHint")} error={errors.appointmentRef}>
              {(p) => <Input {...p} value={h.appointmentRef} onChange={(e) => setH({ ...h, appointmentRef: e.target.value })} maxLength={20} dir="ltr" className="font-mono" placeholder="APT-000123" />}
            </Field>
          )}
          <Field label={t("stock.fields.note")} error={errors.note} className="sm:col-span-2 lg:col-span-3">
            {(p) => <Textarea {...p} value={h.note} onChange={(e) => setH({ ...h, note: e.target.value })} rows={2} maxLength={1000} dir="auto" />}
          </Field>
        </div>
      </Card>

      <Card>
        <CardHeader
          title={t("stock.form.lines")}
          description={errors.lines ? <span className="font-medium text-danger">{t.msg(errors.lines)}</span> : undefined}
          actions={
            <Button size="sm" variant="outline" onClick={() => setLines((ls) => [...ls, blankLine(type)])} disabled={lines.length >= 200}>
              <Plus className="h-4 w-4" /> {t("stock.form.addLine")}
            </Button>
          }
        />
        <ol className="divide-y divide-line">
          {lines.map((l, i) => {
            const serialCount = parseSerials(l.serials).length;
            const takesCost = lineTakesCost(type, returnKind, l.direction || null);
            return (
              <li key={l.key} className="space-y-3 p-5" aria-label={t("stock.form.lineN", { n: i + 1 })}>
                <div className="flex items-start gap-3">
                  <span className="mt-2 w-6 shrink-0 text-sm font-semibold tabular-nums text-fg-subtle">{i + 1}</span>
                  <div className="min-w-0 flex-1">
                    {l.product ? (
                      <div className="flex flex-wrap items-center gap-2">
                        <bdi className="font-mono text-sm font-semibold text-fg">{l.product.sku}</bdi>
                        <span className="text-sm text-fg">{nameOf(l.product, t)}</span>
                        <span className="text-xs text-fg-subtle">({l.product.unit.code})</span>
                        <Button size="sm" variant="ghost" onClick={() => update(l.key, { product: null, serials: "" })}>
                          {t("stock.form.change")}
                        </Button>
                      </div>
                    ) : (
                      <ProductPicker
                        label={t("stock.form.lineN", { n: i + 1 })}
                        warehouseId={availAt?.id ?? ""}
                        error={lineErr(i, "productId")}
                        onPick={(p) => update(l.key, { product: p })}
                      />
                    )}
                    {l.product && availAt && <Availability productId={l.product.id} warehouse={availAt} />}
                  </div>
                  <Button
                    size="icon"
                    variant="ghost"
                    onClick={() => setLines((ls) => (ls.length > 1 ? ls.filter((x) => x.key !== l.key) : [blankLine(type)]))}
                    aria-label={t("stock.form.removeLine", { n: i + 1 })}
                    title={t("stock.form.removeLine", { n: i + 1 })}
                  >
                    <Trash2 className="h-4 w-4" />
                  </Button>
                </div>
                <div className="grid grid-cols-1 gap-3 ps-9 sm:grid-cols-2 lg:grid-cols-4">
                  {type === "ADJUSTMENT" && (
                    <Field label={t("stock.fields.direction")} required error={lineErr(i, "direction")}>
                      {(p) => (
                        <Select {...p} value={l.direction} onChange={(e) => update(l.key, { direction: e.target.value as AdjustDirection })}>
                          <option value="">{t("common.choose")}</option>
                          {ADJUST_DIRECTIONS.map((d) => (
                            <option key={d} value={d}>
                              {t.dyn(`enums.adjustDirection.${d}`)}
                            </option>
                          ))}
                        </Select>
                      )}
                    </Field>
                  )}
                  <Field label={`${t("stock.fields.quantity")}${l.product ? ` (${l.product.unit.code})` : ""}`} required error={lineErr(i, "quantity")}>
                    {(p) => <Input {...p} value={l.quantity} onChange={(e) => update(l.key, { quantity: e.target.value })} inputMode={l.product?.unit.allowsFraction ? "decimal" : "numeric"} dir="ltr" />}
                  </Field>
                  {sides.from && binSelect(from, l.fromBinId, (v) => update(l.key, { fromBinId: v }), t("stock.fields.fromBin"), lineErr(i, "fromBinId"))}
                  {sides.to && binSelect(to, l.toBinId, (v) => update(l.key, { toBinId: v }), type === "ADJUSTMENT" ? t("stock.fields.bin") : t("stock.fields.toBin"), lineErr(i, "toBinId") ?? lineErr(i, "fromBinId"))}
                  {takesCost && showCosts && (
                    <Field label={t("stock.fields.unitCost")} hint={type === "RECEIPT" || type === "OPENING" ? t("stock.fields.unitCostHint") : t("stock.fields.unitCostAvgHint")} error={lineErr(i, "unitCost")}>
                      {(p) => <Input {...p} value={l.unitCost} onChange={(e) => update(l.key, { unitCost: e.target.value })} inputMode="decimal" dir="ltr" />}
                    </Field>
                  )}
                  {takesCost && !showCosts && lineErr(i, "unitCost") && (
                    <p className="text-xs font-medium text-danger sm:col-span-2" role="alert">
                      {t.msg(lineErr(i, "unitCost"))}
                    </p>
                  )}
                  <Field label={t("stock.fields.reason")} required={type === "ADJUSTMENT"} error={lineErr(i, "reason")} className={cn(type !== "ADJUSTMENT" && "lg:col-span-1")}>
                    {(p) => <Input {...p} value={l.reason} onChange={(e) => update(l.key, { reason: e.target.value })} maxLength={300} dir="auto" />}
                  </Field>
                  {takesSerials(l.product) && (
                    <Field
                      label={t("stock.fields.serials")}
                      required={!optionalSerials(l.product)}
                      hint={`${optionalSerials(l.product) ? t("serialModes.hint.OPTIONAL") : t("stock.fields.serialsHint")} ${t("stock.form.serialsCount", { given: serialCount, count: l.quantity || 0 })}`}
                      error={lineErr(i, "serials")}
                      className="sm:col-span-2 lg:col-span-4"
                    >
                      {(p) => <Textarea {...p} value={l.serials} onChange={(e) => update(l.key, { serials: e.target.value })} rows={3} dir="ltr" className="font-mono" />}
                    </Field>
                  )}
                </div>
              </li>
            );
          })}
        </ol>
      </Card>

      {errors._form && (
        <p className="text-sm font-medium text-danger" role="alert">
          {t.msg(errors._form)}
        </p>
      )}
      <div className="flex flex-wrap justify-end gap-2">
        <Button type="submit" variant="outline" loading={busy}>
          {t("stock.form.saveDraft")}
        </Button>
        {canPost && (
          <ConfirmButton
            label={t("stock.form.saveAndPost")}
            title={t("stock.form.postConfirmTitle")}
            text={t("stock.form.postConfirmText")}
            confirmLabel={t("stock.detail.post")}
            busy={busy}
            onConfirm={() => save(true)}
          />
        )}
      </div>
    </form>
  );
}
