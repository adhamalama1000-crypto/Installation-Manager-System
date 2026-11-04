"use client";

import { useState } from "react";
import Link from "next/link";
import { Pencil, Plus, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardHeader } from "@/components/ui/card";
import { Combobox, type ComboOption } from "@/components/ui/combobox";
import { Dialog } from "@/components/ui/dialog";
import { Checkbox, Field, Input } from "@/components/ui/field";
import { Badge } from "@/components/ui/misc";
import { useT } from "@/i18n/client";
import { api } from "@/lib/api-client";
import { money } from "@/lib/constants";
import { formatQuantity } from "@/lib/inventory";
import { tableHead, th, thEnd } from "./labels";
import { useAction } from "./use-action";

export type VariantRow = {
  id: string;
  sku: string;
  barcode: string | null;
  variantNameEn: string | null;
  variantNameAr: string | null;
  colorHex: string | null;
  purchaseCost: number | null;
  sellingPrice: number | null;
  minStock: number;
  isActive: boolean;
  version: number;
  onHand: number;
  low: boolean;
  imageUrl: string | null;
};

type NewRow = { key: number; variantNameEn: string; variantNameAr: string; colorHex: string; sellingPrice: string };
let seq = 0;
const blank = (): NewRow => ({ key: ++seq, variantNameEn: "", variantNameAr: "", colorHex: "", sellingPrice: "" });

/** "Black, أسود, #111111" per line (comma or tab) into rows; empty lines are skipped. */
export function parseVariantLines(text: string): Omit<NewRow, "key">[] {
  return text
    .split(/\r?\n/)
    .map((l) => l.split(/\t|,|،/).map((x) => x.trim()))
    .filter((cells) => cells.some(Boolean))
    .map(([en = "", ar = "", c3 = "", c4 = ""]) => {
      const color = [c3, c4].find((c) => /^#?[0-9a-f]{6}$/i.test(c)) ?? "";
      const price = [c3, c4].find((c) => c !== color && /^\d+(\.\d+)?$/.test(c.replace(/,/g, ""))) ?? "";
      return { variantNameEn: en, variantNameAr: ar || en, colorHex: color && !color.startsWith("#") ? `#${color}` : color, sellingPrice: price };
    });
}

function Swatch({ color }: { color: string | null }) {
  if (!color) return <span className="inline-block h-4 w-4 rounded border border-dashed border-line-strong" aria-hidden />;
  return <span className="inline-block h-4 w-4 rounded border border-line-strong" style={{ backgroundColor: color }} aria-hidden />;
}

/**
 * The variants of a product: the list with stock and prices, a dialog to edit one, rows (or pasted
 * lines) to add several at once with generated codes, and attaching a product that already exists.
 */
export function VariantsPanel({
  productId,
  productName,
  variants,
  manage,
  showCosts,
  unitCode,
  stockedOnParent,
}: {
  productId: string;
  productName: string;
  variants: VariantRow[];
  manage: boolean;
  showCosts: boolean;
  unitCode: string;
  /** The product holds stock itself, so it cannot get variants until that is zero. */
  stockedOnParent: boolean;
}) {
  const t = useT();
  const L = t.locale;
  const { busy, errors, run, setErrors } = useAction();
  const [rows, setRows] = useState<NewRow[]>([blank()]);
  const [paste, setPaste] = useState("");
  const [genBarcodes, setGenBarcodes] = useState(false);
  const [editing, setEditing] = useState<VariantRow | null>(null);
  const [attachOpen, setAttachOpen] = useState(false);

  async function create() {
    const list = rows.filter((r) => r.variantNameEn.trim() || r.variantNameAr.trim());
    const res = await run(
      () =>
        api<{ created: unknown[] }>(`/api/products/${productId}/variants`, {
          method: "POST",
          body: { variants: list.map((r) => ({ variantNameEn: r.variantNameEn, variantNameAr: r.variantNameAr, colorHex: r.colorHex, sellingPrice: r.sellingPrice, generateBarcode: genBarcodes })) },
        }),
      (r) => t("variants.created", { count: r.created.length }),
    );
    if (res) setRows([blank()]);
  }

  function addPasted() {
    const parsed = parseVariantLines(paste);
    if (!parsed.length) return;
    setRows((rs) => [...rs.filter((r) => r.variantNameEn || r.variantNameAr), ...parsed.map((p) => ({ ...p, key: ++seq }))]);
    setPaste("");
  }

  return (
    <Card className="overflow-hidden">
      <CardHeader title={t("variants.title")} description={t("variants.description")} />
      {variants.length === 0 ? (
        <p className="px-5 pb-4 text-sm text-fg-muted">{t("variants.none")}</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full min-w-[640px] text-sm">
            <thead className={tableHead}>
              <tr>
                <th className={th}>{t("variants.code")}</th>
                <th className={th}>{t("variants.title")}</th>
                <th className={th}>{t("catalog.products.barcode")}</th>
                <th className={thEnd}>{t("catalog.onHand")}</th>
                {showCosts && <th className={thEnd}>{t("catalog.products.purchaseCost")}</th>}
                <th className={thEnd}>{t("catalog.products.sellingPrice")}</th>
                {manage && <th className="w-10" />}
              </tr>
            </thead>
            <tbody className="divide-y divide-line">
              {variants.map((v) => (
                <tr key={v.id} className={v.isActive ? "" : "opacity-60"}>
                  <td className="px-4 py-2">
                    <Link prefetch={false} href={`/products/${v.id}`} className="font-mono font-semibold text-brand-text hover:underline">
                      <bdi>{v.sku}</bdi>
                    </Link>
                  </td>
                  <td className="px-4 py-2">
                    <span className="inline-flex items-center gap-2">
                      <Swatch color={v.colorHex} />
                      <span className="font-medium">{L === "ar" ? v.variantNameAr : v.variantNameEn}</span>
                      {!v.isActive && <Badge>{t("common.inactive")}</Badge>}
                      {v.low && <Badge className="border-warning/40 bg-warning-soft text-fg">{t("catalog.lowStock")}</Badge>}
                    </span>
                  </td>
                  <td className="px-4 py-2 font-mono text-xs text-fg-muted">{v.barcode ?? "—"}</td>
                  <td className="px-4 py-2 text-end tabular-nums">
                    {formatQuantity(v.onHand, L)} <span className="text-xs text-fg-subtle">{unitCode}</span>
                  </td>
                  {showCosts && <td className="px-4 py-2 text-end tabular-nums">{money(v.purchaseCost, L)}</td>}
                  <td className="px-4 py-2 text-end tabular-nums">{money(v.sellingPrice, L)}</td>
                  {manage && (
                    <td className="px-2 py-2 text-end">
                      <button type="button" className="rounded p-1.5 text-fg-subtle hover:bg-surface-muted hover:text-fg" aria-label={`${t("variants.edit")} ${v.sku}`} onClick={() => setEditing(v)}>
                        <Pencil className="h-4 w-4" />
                      </button>
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {manage && (
        <div className="space-y-4 border-t border-line p-5">
          {stockedOnParent ? (
            <p className="text-sm text-fg-muted">{t("variants.errors.parentHasStock", { product: productName })}</p>
          ) : (
            <>
              <h3 className="text-sm font-semibold">{t("variants.add")}</h3>
              <div className="space-y-2">
                {rows.map((r, i) => (
                  <div key={r.key} className="grid grid-cols-1 gap-2 sm:grid-cols-[1fr_1fr_7rem_7rem_auto]">
                    <Input aria-label={`${t("variants.nameEn")} ${i + 1}`} placeholder={t("variants.nameEn")} value={r.variantNameEn} dir="ltr" onChange={(e) => setRows((rs) => rs.map((x) => (x.key === r.key ? { ...x, variantNameEn: e.target.value } : x)))} aria-invalid={errors[`variants.${i}.variantNameEn`] ? true : undefined} />
                    <Input aria-label={`${t("variants.nameAr")} ${i + 1}`} placeholder={t("variants.nameAr")} value={r.variantNameAr} dir="rtl" onChange={(e) => setRows((rs) => rs.map((x) => (x.key === r.key ? { ...x, variantNameAr: e.target.value } : x)))} />
                    <div className="flex items-center gap-1">
                      <input type="color" aria-label={`${t("variants.color")} ${i + 1}`} value={r.colorHex || "#ffffff"} onChange={(e) => setRows((rs) => rs.map((x) => (x.key === r.key ? { ...x, colorHex: e.target.value } : x)))} className="h-10 w-10 cursor-pointer rounded border border-line-strong bg-surface" />
                      {r.colorHex && (
                        <button type="button" className="text-xs text-fg-subtle hover:text-fg" onClick={() => setRows((rs) => rs.map((x) => (x.key === r.key ? { ...x, colorHex: "" } : x)))}>
                          {t("common.none")}
                        </button>
                      )}
                    </div>
                    <Input aria-label={`${t("catalog.products.sellingPrice")} ${i + 1}`} placeholder={t("catalog.products.sellingPrice")} value={r.sellingPrice} inputMode="decimal" dir="ltr" onChange={(e) => setRows((rs) => rs.map((x) => (x.key === r.key ? { ...x, sellingPrice: e.target.value } : x)))} />
                    <button type="button" className="flex h-10 w-10 items-center justify-center rounded text-fg-subtle hover:bg-surface-muted hover:text-danger" aria-label={`${t("common.delete")} ${i + 1}`} onClick={() => setRows((rs) => (rs.length > 1 ? rs.filter((x) => x.key !== r.key) : [blank()]))}>
                      <Trash2 className="h-4 w-4" />
                    </button>
                    {(errors[`variants.${i}.variantNameEn`] || errors[`variants.${i}.sku`]) && (
                      <p className="text-xs font-medium text-danger sm:col-span-5" role="alert">
                        {t.msg(errors[`variants.${i}.variantNameEn`] ?? errors[`variants.${i}.sku`])}
                      </p>
                    )}
                  </div>
                ))}
              </div>
              <div className="flex flex-wrap items-center gap-2">
                <Button type="button" variant="outline" size="sm" onClick={() => setRows((rs) => [...rs, blank()])}>
                  <Plus className="h-4 w-4" /> {t("variants.addRow")}
                </Button>
                <Checkbox label={t("codes.generateBarcode")} checked={genBarcodes} onChange={(e) => setGenBarcodes(e.target.checked)} />
              </div>
              <Field label={t("variants.add")} hint={t("variants.addHint")}>
                {(p) => (
                  <div className="flex flex-col gap-2 sm:flex-row">
                    <textarea {...p} value={paste} onChange={(e) => setPaste(e.target.value)} rows={3} dir="auto" className="min-h-20 flex-1 rounded-lg border border-line-strong bg-surface px-3 py-2 text-sm" />
                    <Button type="button" variant="secondary" onClick={addPasted} disabled={!paste.trim()}>
                      {t("common.add")}
                    </Button>
                  </div>
                )}
              </Field>
              {errors._form && (
                <p className="text-sm font-medium text-danger" role="alert">
                  {t.msg(errors._form)}
                </p>
              )}
              <div className="flex flex-wrap justify-between gap-2">
                <Button type="button" variant="ghost" onClick={() => setAttachOpen(true)}>
                  {t("variants.attach")}
                </Button>
                <Button type="button" loading={busy} onClick={() => void create()} disabled={!rows.some((r) => r.variantNameEn.trim())}>
                  {t("variants.create")}
                </Button>
              </div>
            </>
          )}
        </div>
      )}

      {editing && <VariantDialog productId={productId} variant={editing} showCosts={showCosts} onClose={() => setEditing(null)} />}
      {attachOpen && (
        <AttachDialog
          productId={productId}
          onClose={() => {
            setAttachOpen(false);
            setErrors({});
          }}
        />
      )}
    </Card>
  );
}

/** On a variant's own page: opens the same editor as the product's variants list. */
export function EditVariantButton({ productId, variant, showCosts }: { productId: string; variant: VariantRow; showCosts: boolean }) {
  const t = useT();
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button type="button" variant="outline" size="sm" onClick={() => setOpen(true)}>
        <Pencil className="h-4 w-4" /> {t("variants.edit")}
      </Button>
      {open && <VariantDialog productId={productId} variant={variant} showCosts={showCosts} onClose={() => setOpen(false)} />}
    </>
  );
}

function VariantDialog({ productId, variant, showCosts, onClose }: { productId: string; variant: VariantRow; showCosts: boolean; onClose: () => void }) {
  const t = useT();
  const { busy, errors, run } = useAction();
  const [v, setV] = useState({
    sku: variant.sku,
    barcode: variant.barcode ?? "",
    variantNameEn: variant.variantNameEn ?? "",
    variantNameAr: variant.variantNameAr ?? "",
    colorHex: variant.colorHex ?? "",
    purchaseCost: variant.purchaseCost === null ? "" : String(variant.purchaseCost),
    sellingPrice: variant.sellingPrice === null ? "" : String(variant.sellingPrice),
    minStock: String(variant.minStock),
    isActive: variant.isActive,
  });
  const set = (k: keyof typeof v) => (e: React.ChangeEvent<HTMLInputElement>) => setV((s) => ({ ...s, [k]: e.target.value }));
  async function save() {
    const body = { ...v, ...(showCosts ? {} : { purchaseCost: variant.purchaseCost }), version: variant.version };
    const r = await run(() => api(`/api/products/${productId}/variants/${variant.id}`, { method: "PATCH", body }), () => t("variants.saved"));
    if (r) onClose();
  }
  async function detach() {
    const r = await run(() => api(`/api/products/${variant.id}/detach`, { method: "POST", body: {} }), () => t("catalog.saved"));
    if (r) onClose();
  }
  return (
    <Dialog
      open
      onClose={onClose}
      title={`${t("variants.edit")} · ${variant.sku}`}
      footer={
        <div className="flex w-full flex-wrap justify-between gap-2">
          <Button type="button" variant="ghost" onClick={() => void detach()} disabled={busy}>
            {t("variants.detach")}
          </Button>
          <div className="flex gap-2">
            <Button type="button" variant="outline" onClick={onClose}>
              {t("common.cancel")}
            </Button>
            <Button type="button" loading={busy} onClick={() => void save()}>
              {t("common.saveChanges")}
            </Button>
          </div>
        </div>
      }
    >
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <Field label={t("variants.nameEn")} required error={errors.variantNameEn}>
          {(p) => <Input {...p} value={v.variantNameEn} onChange={set("variantNameEn")} dir="ltr" />}
        </Field>
        <Field label={t("variants.nameAr")} required error={errors.variantNameAr}>
          {(p) => <Input {...p} value={v.variantNameAr} onChange={set("variantNameAr")} dir="rtl" />}
        </Field>
        <Field label={t("variants.code")} error={errors.sku} hint={t("codes.skuEditHint")}>
          {(p) => <Input {...p} value={v.sku} onChange={set("sku")} dir="ltr" className="font-mono" />}
        </Field>
        <Field label={t("catalog.products.barcode")} error={errors.barcode}>
          {(p) => <Input {...p} value={v.barcode} onChange={set("barcode")} dir="ltr" className="font-mono" />}
        </Field>
        <Field label={t("variants.color")} error={errors.colorHex}>
          {(p) => (
            <div className="flex items-center gap-2">
              <input {...p} type="color" value={v.colorHex || "#ffffff"} onChange={set("colorHex")} className="h-10 w-12 cursor-pointer rounded border border-line-strong bg-surface" />
              <Input aria-label={t("variants.color")} value={v.colorHex} onChange={set("colorHex")} dir="ltr" className="font-mono" placeholder="#000000" />
            </div>
          )}
        </Field>
        <Field label={t("catalog.products.minStock")} error={errors.minStock}>
          {(p) => <Input {...p} value={v.minStock} onChange={set("minStock")} inputMode="decimal" dir="ltr" />}
        </Field>
        {showCosts && (
          <Field label={t("catalog.products.purchaseCost")} error={errors.purchaseCost}>
            {(p) => <Input {...p} value={v.purchaseCost} onChange={set("purchaseCost")} inputMode="decimal" dir="ltr" />}
          </Field>
        )}
        <Field label={t("catalog.products.sellingPrice")} error={errors.sellingPrice}>
          {(p) => <Input {...p} value={v.sellingPrice} onChange={set("sellingPrice")} inputMode="decimal" dir="ltr" />}
        </Field>
        <div className="sm:col-span-2">
          <Checkbox label={t("catalog.products.active")} checked={v.isActive} onChange={(e) => setV((s) => ({ ...s, isActive: e.target.checked }))} />
          {errors.isActive && (
            <p className="text-xs font-medium text-danger" role="alert">
              {t.msg(errors.isActive)}
            </p>
          )}
        </div>
      </div>
    </Dialog>
  );
}

function AttachDialog({ productId, onClose }: { productId: string; onClose: () => void }) {
  const t = useT();
  const { busy, errors, run } = useAction();
  const [picked, setPicked] = useState<{ id: string; label: string } | null>(null);
  const [nameEn, setNameEn] = useState("");
  const [nameAr, setNameAr] = useState("");
  const load = async (q: string, signal: AbortSignal): Promise<ComboOption[]> => {
    const r = await api<{ rows: { id: string; sku: string; nameEn: string; nameAr: string; parent: unknown; hasVariants: boolean }[] }>(`/api/products?${new URLSearchParams({ q, level: "top", pageSize: "10", sort: "sku" })}`, { signal });
    return r.rows.filter((p) => p.id !== productId && !p.hasVariants).map((p) => ({ id: p.id, label: `${p.sku} · ${t.locale === "ar" ? p.nameAr : p.nameEn}` }));
  };
  async function save() {
    const r = await run(() => api(`/api/products/${productId}/variants/attach`, { method: "POST", body: { productId: picked?.id ?? "", variantNameEn: nameEn, variantNameAr: nameAr } }), () => t("variants.attached"));
    if (r) onClose();
  }
  return (
    <Dialog
      open
      onClose={onClose}
      title={t("variants.attach")}
      description={t("variants.attachHint")}
      footer={
        <>
          <Button type="button" variant="outline" onClick={onClose}>
            {t("common.cancel")}
          </Button>
          <Button type="button" loading={busy} onClick={() => void save()} disabled={!picked}>
            {t("variants.attach")}
          </Button>
        </>
      }
    >
      <div className="grid grid-cols-1 gap-3">
        <Field label={t("variants.existing")} required error={errors.productId ?? errors._form}>
          {(p) => (
            <Combobox
              id={p.id}
              label={t("variants.existing")}
              load={load}
              minChars={2}
              value={picked?.id ?? null}
              selectedLabel={picked?.label}
              onChange={(id, o) => setPicked(id && o ? { id, label: o.label } : null)}
              placeholder={t("stock.form.productSearch")}
              invalid={!!p["aria-invalid"]}
            />
          )}
        </Field>
        <Field label={t("variants.nameEn")} required error={errors.variantNameEn}>
          {(p) => <Input {...p} value={nameEn} onChange={(e) => setNameEn(e.target.value)} dir="ltr" />}
        </Field>
        <Field label={t("variants.nameAr")} required error={errors.variantNameAr}>
          {(p) => <Input {...p} value={nameAr} onChange={(e) => setNameAr(e.target.value)} dir="rtl" />}
        </Field>
      </div>
    </Dialog>
  );
}
