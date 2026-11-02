"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Card, CardHeader } from "@/components/ui/card";
import { Checkbox, Field, Input, Select, Textarea } from "@/components/ui/field";
import { useT } from "@/i18n/client";
import { api } from "@/lib/api-client";
import { nameOf } from "./labels";
import { useAction } from "./use-action";

type Option = { id: string; nameEn: string; nameAr: string; isActive: boolean };
export type CatalogOptions = {
  units: (Option & { code: string; allowsFraction: boolean })[];
  categories: (Option & { parentId: string | null })[];
  brands: { id: string; name: string; isActive: boolean }[];
};
export type ProductInitial = {
  id: string;
  version: number;
  sku: string;
  barcode: string | null;
  nameEn: string;
  nameAr: string;
  model: string | null;
  description: string | null;
  unitId: string;
  categoryId: string | null;
  parentCategoryId: string | null;
  brandId: string | null;
  purchaseCost: number | null;
  sellingPrice: number | null;
  minStock: number;
  warrantyMonths: number;
  trackSerials: boolean;
  isActive: boolean;
  hasMovements: boolean;
};

const str = (v: number | null | undefined) => (v === null || v === undefined ? "" : String(v));

/** Create or edit a product. Inactive choices stay selectable only where the product already has them. */
export function ProductForm({ options, initial }: { options: CatalogOptions; initial?: ProductInitial }) {
  const t = useT();
  const router = useRouter();
  const { busy, errors, run } = useAction();
  const [v, setV] = useState({
    sku: initial?.sku ?? "",
    barcode: initial?.barcode ?? "",
    nameEn: initial?.nameEn ?? "",
    nameAr: initial?.nameAr ?? "",
    model: initial?.model ?? "",
    description: initial?.description ?? "",
    unitId: initial?.unitId ?? options.units.find((u) => u.isActive)?.id ?? "",
    category: initial?.parentCategoryId ?? initial?.categoryId ?? "",
    subcategory: initial?.parentCategoryId ? (initial.categoryId ?? "") : "",
    brandId: initial?.brandId ?? "",
    purchaseCost: str(initial?.purchaseCost),
    sellingPrice: str(initial?.sellingPrice),
    minStock: str(initial?.minStock ?? 0),
    warrantyMonths: str(initial?.warrantyMonths ?? 0),
    trackSerials: initial?.trackSerials ?? false,
    isActive: initial?.isActive ?? true,
  });
  const set = (k: keyof typeof v) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>) => setV((s) => ({ ...s, [k]: e.target.value }));
  const usable = <O extends { id: string; isActive: boolean }>(list: O[], current: string | null | undefined) => list.filter((o) => o.isActive || o.id === current);
  const tops = usable(options.categories.filter((c) => !c.parentId), initial?.parentCategoryId ?? initial?.categoryId);
  const subs = usable(options.categories.filter((c) => c.parentId && c.parentId === v.category), initial?.categoryId);
  const locked = !!initial?.hasMovements;
  const unit = options.units.find((u) => u.id === v.unitId);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    const body = {
      sku: v.sku,
      barcode: v.barcode,
      nameEn: v.nameEn,
      nameAr: v.nameAr,
      model: v.model,
      description: v.description,
      unitId: v.unitId,
      categoryId: v.subcategory || v.category || null,
      brandId: v.brandId || null,
      purchaseCost: v.purchaseCost,
      sellingPrice: v.sellingPrice,
      minStock: v.minStock,
      warrantyMonths: v.warrantyMonths,
      trackSerials: v.trackSerials,
      isActive: v.isActive,
      ...(initial ? { version: initial.version } : {}),
    };
    const r = await run(
      () =>
        initial
          ? api<{ product: { id: string } }>(`/api/products/${initial.id}`, { method: "PATCH", body })
          : api<{ product: { id: string } }>("/api/products", { method: "POST", body }),
      () => (initial ? t("catalog.saved") : t("catalog.created")),
      { refresh: !!initial },
    );
    if (r && !initial) router.push(`/products/${r.product.id}`);
  }

  return (
    <Card>
      <CardHeader title={initial ? t("catalog.editProduct") : t("common.details")} description={initial ? undefined : t("catalog.newProductText")} />
      <form className="grid grid-cols-1 gap-4 p-5 sm:grid-cols-2" noValidate onSubmit={submit}>
        <Field label={t("catalog.products.sku")} required hint={t("catalog.products.skuHint")} error={errors.sku}>
          {(p) => <Input {...p} value={v.sku} onChange={set("sku")} maxLength={64} autoCapitalize="characters" dir="ltr" className="font-mono" />}
        </Field>
        <Field label={t("catalog.products.barcode")} error={errors.barcode}>
          {(p) => <Input {...p} value={v.barcode} onChange={set("barcode")} maxLength={64} inputMode="text" dir="ltr" className="font-mono" />}
        </Field>
        <Field label={t("catalog.nameEn")} required error={errors.nameEn}>
          {(p) => <Input {...p} value={v.nameEn} onChange={set("nameEn")} maxLength={200} dir="ltr" />}
        </Field>
        <Field label={t("catalog.nameAr")} required error={errors.nameAr}>
          {(p) => <Input {...p} value={v.nameAr} onChange={set("nameAr")} maxLength={200} dir="rtl" />}
        </Field>
        <Field label={t("catalog.products.category")} error={errors.categoryId}>
          {(p) => (
            <Select {...p} value={v.category} onChange={(e) => setV((s) => ({ ...s, category: e.target.value, subcategory: "" }))}>
              <option value="">{t("catalog.products.noCategory")}</option>
              {tops.map((c) => (
                <option key={c.id} value={c.id}>
                  {nameOf(c, t)}
                </option>
              ))}
            </Select>
          )}
        </Field>
        <Field label={t("catalog.products.subcategory")}>
          {(p) => (
            <Select {...p} value={v.subcategory} onChange={set("subcategory")} disabled={!subs.length}>
              <option value="">{t("catalog.products.noSubcategory")}</option>
              {subs.map((c) => (
                <option key={c.id} value={c.id}>
                  {nameOf(c, t)}
                </option>
              ))}
            </Select>
          )}
        </Field>
        <Field label={t("catalog.products.brand")} error={errors.brandId}>
          {(p) => (
            <Select {...p} value={v.brandId} onChange={set("brandId")}>
              <option value="">{t("catalog.products.noBrand")}</option>
              {usable(options.brands, initial?.brandId).map((b) => (
                <option key={b.id} value={b.id}>
                  {b.name}
                </option>
              ))}
            </Select>
          )}
        </Field>
        <Field label={t("catalog.products.model")} error={errors.model}>
          {(p) => <Input {...p} value={v.model} onChange={set("model")} maxLength={100} dir="auto" />}
        </Field>
        <Field label={t("catalog.products.unit")} required error={errors.unitId} hint={locked ? t("catalog.fixedAfterMovement") : undefined}>
          {(p) => (
            <Select {...p} value={v.unitId} onChange={set("unitId")} disabled={locked}>
              {usable(options.units, initial?.unitId).map((u) => (
                <option key={u.id} value={u.id}>
                  {nameOf(u, t)} ({u.code})
                </option>
              ))}
            </Select>
          )}
        </Field>
        <Field label={t("catalog.products.minStock")} hint={t("catalog.products.minStockHint")} error={errors.minStock}>
          {(p) => <Input {...p} value={v.minStock} onChange={set("minStock")} inputMode="decimal" dir="ltr" />}
        </Field>
        <Field label={t("catalog.products.purchaseCost")} hint={t("catalog.products.purchaseCostHint")} error={errors.purchaseCost}>
          {(p) => <Input {...p} value={v.purchaseCost} onChange={set("purchaseCost")} inputMode="decimal" dir="ltr" />}
        </Field>
        <Field label={t("catalog.products.sellingPrice")} error={errors.sellingPrice}>
          {(p) => <Input {...p} value={v.sellingPrice} onChange={set("sellingPrice")} inputMode="decimal" dir="ltr" />}
        </Field>
        <Field label={t("catalog.products.warrantyMonths")} error={errors.warrantyMonths}>
          {(p) => <Input {...p} value={v.warrantyMonths} onChange={set("warrantyMonths")} inputMode="numeric" dir="ltr" />}
        </Field>
        <Field label={t("catalog.products.description")} error={errors.description} className="sm:col-span-2">
          {(p) => <Textarea {...p} value={v.description} onChange={set("description")} rows={3} maxLength={2000} dir="auto" />}
        </Field>
        <div className="space-y-1 sm:col-span-2">
          <Checkbox
            label={t("catalog.products.trackSerials")}
            description={locked ? t("catalog.fixedAfterMovement") : unit?.allowsFraction ? t("catalog.errors.serialsWhole") : t("catalog.products.trackSerialsHint")}
            checked={v.trackSerials}
            disabled={locked || (!!unit?.allowsFraction && !v.trackSerials)}
            onChange={(e) => setV((s) => ({ ...s, trackSerials: e.target.checked }))}
          />
          {errors.trackSerials && (
            <p className="text-xs font-medium text-danger" role="alert">
              {t.msg(errors.trackSerials)}
            </p>
          )}
          <Checkbox label={t("catalog.products.active")} description={t("catalog.products.activeHint")} checked={v.isActive} onChange={(e) => setV((s) => ({ ...s, isActive: e.target.checked }))} />
        </div>
        <div className="flex justify-end gap-2 sm:col-span-2">
          <Button type="submit" loading={busy}>
            {initial ? t("common.saveChanges") : t("common.save")}
          </Button>
        </div>
      </form>
    </Card>
  );
}
