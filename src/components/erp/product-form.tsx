"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Card, CardHeader } from "@/components/ui/card";
import { Combobox, type ComboOption } from "@/components/ui/combobox";
import { DraftBanner } from "@/components/ui/draft-banner";
import { Checkbox, Field, Input, Select, Textarea } from "@/components/ui/field";
import { useT } from "@/i18n/client";
import { api } from "@/lib/api-client";
import { SERIAL_MODES, type SerialMode } from "@/lib/inventory";
import { recallChoice, rememberChoice, useDraft } from "@/lib/use-draft";
import { nameOf } from "./labels";
import { useAction } from "./use-action";

type Option = { id: string; nameEn: string; nameAr: string; isActive: boolean };
export type CatalogOptions = {
  units: (Option & { code: string; allowsFraction: boolean })[];
  categories: (Option & { parentId: string | null; code?: string | null })[];
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
  serialMode?: SerialMode;
  isActive: boolean;
  hasMovements: boolean;
  hasVariants?: boolean;
};
/** A record to start a new product from ("Duplicate"): everything but the codes. */
export type ProductCopy = Omit<ProductInitial, "id" | "version" | "sku" | "barcode" | "hasMovements">;

const str = (v: number | null | undefined) => (v === null || v === undefined ? "" : String(v));

type Values = {
  sku: string;
  barcode: string;
  generateBarcode: boolean;
  nameEn: string;
  nameAr: string;
  model: string;
  description: string;
  unitId: string;
  categoryId: string;
  brandId: string;
  purchaseCost: string;
  sellingPrice: string;
  minStock: string;
  warrantyMonths: string;
  serialMode: SerialMode;
  isActive: boolean;
};

function valuesOf(options: CatalogOptions, src?: ProductCopy | ProductInitial | null, codes?: { sku: string; barcode: string | null } | null): Values {
  return {
    sku: codes?.sku ?? "",
    barcode: codes?.barcode ?? "",
    generateBarcode: false,
    nameEn: src?.nameEn ?? "",
    nameAr: src?.nameAr ?? "",
    model: src?.model ?? "",
    description: src?.description ?? "",
    unitId: src?.unitId ?? options.units.find((u) => u.isActive)?.id ?? "",
    categoryId: src?.categoryId ?? "",
    brandId: src?.brandId ?? "",
    purchaseCost: str(src?.purchaseCost),
    sellingPrice: str(src?.sellingPrice),
    minStock: str(src?.minStock ?? 0),
    warrantyMonths: str(src?.warrantyMonths ?? 0),
    serialMode: src?.serialMode ?? (src?.trackSerials ? "REQUIRED" : "NONE"),
    isActive: src?.isActive ?? true,
  };
}

/**
 * Create or edit a product. On a new product the code is generated when left empty, the last
 * category, brand and unit are offered again, an unsaved form is kept as a draft in this browser,
 * and "Save and add another" keeps the shared details for the next product.
 */
export function ProductForm({ options, initial, copyFrom, timezone }: { options: CatalogOptions; initial?: ProductInitial; copyFrom?: ProductCopy | null; timezone?: string }) {
  const t = useT();
  const router = useRouter();
  const { busy, errors, run } = useAction();
  const creating = !initial;
  const [v, setV] = useState<Values>(() => {
    if (initial) return valuesOf(options, initial, { sku: initial.sku, barcode: initial.barcode });
    if (copyFrom) return { ...valuesOf(options, copyFrom), nameEn: t("forms.copyOf", { name: copyFrom.nameEn }), nameAr: `${copyFrom.nameAr} (${t("forms.duplicate")})` };
    return valuesOf(options);
  });
  // Offer the category, brand and unit used last on a blank new form (browser storage, so after mounting).
  useEffect(() => {
    if (!creating || copyFrom) return;
    const unit = recallChoice("product.unit");
    const cat = recallChoice("product.category");
    const brand = recallChoice("product.brand");
    // eslint-disable-next-line react-hooks/set-state-in-effect -- reading browser storage once after mount
    setV((s) => ({
      ...s,
      unitId: unit && options.units.some((u) => u.id === unit && u.isActive) ? unit : s.unitId,
      categoryId: cat && options.categories.some((c) => c.id === cat && c.isActive) ? cat : s.categoryId,
      brandId: brand && options.brands.some((b) => b.id === brand && b.isActive) ? brand : s.brandId,
    }));
  }, [creating, copyFrom, options]);
  const draft = useDraft<Values>("product:new", v, { enabled: creating && !copyFrom, dirty: !!(v.nameEn || v.nameAr || v.sku || v.description) });
  const nameRef = useRef<HTMLInputElement>(null);

  const set = (k: keyof Values) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>) => setV((s) => ({ ...s, [k]: e.target.value }));
  const locked = !!initial?.hasMovements;
  const unit = options.units.find((u) => u.id === v.unitId);
  const usable = <O extends { id: string; isActive: boolean }>(list: O[], current: string | null | undefined) => list.filter((o) => o.isActive || o.id === current);

  // One searchable list: "Locks", "Locks › Door locks", ...
  const categoryOptions = useMemo<ComboOption[]>(() => {
    const cats = usable(options.categories, initial?.categoryId);
    const byId = new Map(options.categories.map((c) => [c.id, c]));
    return cats
      .map((c) => {
        const parent = c.parentId ? byId.get(c.parentId) : null;
        return { id: c.id, label: parent ? `${nameOf(parent, t)} › ${nameOf(c, t)}` : nameOf(c, t), hint: c.code ?? undefined, keywords: `${c.nameEn} ${c.nameAr}` };
      })
      .sort((a, b) => a.label.localeCompare(b.label, t.locale));
  }, [options.categories, initial?.categoryId, t]);
  const brandOptions = useMemo<ComboOption[]>(() => usable(options.brands, initial?.brandId).map((b) => ({ id: b.id, label: b.name })), [options.brands, initial?.brandId]);

  async function submit(addAnother: boolean) {
    const body = {
      sku: v.sku,
      barcode: v.barcode,
      generateBarcode: v.generateBarcode,
      nameEn: v.nameEn,
      nameAr: v.nameAr,
      model: v.model,
      description: v.description,
      unitId: v.unitId,
      categoryId: v.categoryId || null,
      brandId: v.brandId || null,
      purchaseCost: v.purchaseCost,
      sellingPrice: v.sellingPrice,
      minStock: v.minStock,
      warrantyMonths: v.warrantyMonths,
      serialMode: v.serialMode,
      isActive: v.isActive,
      ...(initial ? { version: initial.version } : {}),
    };
    const r = await run(
      () =>
        initial
          ? api<{ product: { id: string; sku: string } }>(`/api/products/${initial.id}`, { method: "PATCH", body })
          : api<{ product: { id: string; sku: string } }>("/api/products", { method: "POST", body }),
      (res) => (initial ? t("catalog.saved") : `${t("catalog.created")} ${res.product.sku}`),
      { refresh: !!initial },
    );
    if (!r || initial) return;
    draft.clear();
    rememberChoice("product.unit", v.unitId);
    rememberChoice("product.category", v.categoryId || null);
    rememberChoice("product.brand", v.brandId || null);
    if (addAnother) {
      // Keep what the next product most likely shares; clear what identifies this one.
      setV((s) => ({ ...s, sku: "", barcode: "", generateBarcode: s.generateBarcode, nameEn: "", nameAr: "", model: "", description: "" }));
      toast.message(t("forms.savedAddAnother"));
      nameRef.current?.focus();
    } else router.push(`/products/${r.product.id}`);
  }

  return (
    <Card>
      <CardHeader title={initial ? t("catalog.editProduct") : t("common.details")} description={initial ? undefined : t("catalog.newProductText")} />
      <form
        className="grid grid-cols-1 gap-4 p-5 sm:grid-cols-2"
        noValidate
        onSubmit={(e) => {
          e.preventDefault();
          void submit(false);
        }}
      >
        {draft.saved && (
          <div className="sm:col-span-2">
            <DraftBanner
              at={draft.saved.at}
              timezone={timezone ?? "Africa/Cairo"}
              onRestore={() => {
                setV(draft.saved!.values);
                draft.dismiss();
              }}
              onDiscard={draft.clear}
            />
          </div>
        )}
        <Field label={t("catalog.nameEn")} required error={errors.nameEn}>
          {(p) => <Input {...p} ref={nameRef} value={v.nameEn} onChange={set("nameEn")} maxLength={200} dir="ltr" autoFocus={creating} />}
        </Field>
        <Field label={t("catalog.nameAr")} required error={errors.nameAr}>
          {(p) => <Input {...p} value={v.nameAr} onChange={set("nameAr")} maxLength={200} dir="rtl" />}
        </Field>
        <Field label={t("catalog.products.sku")} required={!creating} hint={creating ? t("codes.skuAuto") : t("codes.skuEditHint")} error={errors.sku}>
          {(p) => <Input {...p} value={v.sku} onChange={set("sku")} maxLength={64} autoCapitalize="characters" dir="ltr" className="font-mono" placeholder={creating ? "PRD-00001" : undefined} />}
        </Field>
        <Field label={t("catalog.products.barcode")} error={errors.barcode}>
          {(p) => <Input {...p} value={v.barcode} onChange={set("barcode")} maxLength={64} inputMode="text" dir="ltr" className="font-mono" />}
        </Field>
        <Field label={t("catalog.products.category")} error={errors.categoryId}>
          {(p) => (
            <Combobox
              id={p.id}
              invalid={!!p["aria-invalid"]}
              describedBy={p["aria-describedby"]}
              label={t("catalog.products.category")}
              options={categoryOptions}
              value={v.categoryId || null}
              onChange={(id) => setV((s) => ({ ...s, categoryId: id ?? "" }))}
              allowClear
              clearLabel={t("catalog.products.noCategory")}
              placeholder={t("catalog.products.noCategory")}
            />
          )}
        </Field>
        <Field label={t("catalog.products.brand")} error={errors.brandId}>
          {(p) => (
            <Combobox
              id={p.id}
              invalid={!!p["aria-invalid"]}
              describedBy={p["aria-describedby"]}
              label={t("catalog.products.brand")}
              options={brandOptions}
              value={v.brandId || null}
              onChange={(id) => setV((s) => ({ ...s, brandId: id ?? "" }))}
              allowClear
              clearLabel={t("catalog.products.noBrand")}
              placeholder={t("catalog.products.noBrand")}
            />
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
        <Field label={t("catalog.products.purchaseCost")} hint={t("catalog.products.purchaseCostHint")} error={errors.purchaseCost}>
          {(p) => <Input {...p} value={v.purchaseCost} onChange={set("purchaseCost")} inputMode="decimal" dir="ltr" />}
        </Field>
        <Field label={t("catalog.products.sellingPrice")} error={errors.sellingPrice}>
          {(p) => <Input {...p} value={v.sellingPrice} onChange={set("sellingPrice")} inputMode="decimal" dir="ltr" />}
        </Field>
        <Field label={t("catalog.products.minStock")} hint={initial?.hasVariants ? t("variants.stockOnVariants") : t("catalog.products.minStockHint")} error={errors.minStock}>
          {(p) => <Input {...p} value={v.minStock} onChange={set("minStock")} inputMode="decimal" dir="ltr" disabled={initial?.hasVariants} />}
        </Field>
        <Field label={t("catalog.products.warrantyMonths")} error={errors.warrantyMonths}>
          {(p) => <Input {...p} value={v.warrantyMonths} onChange={set("warrantyMonths")} inputMode="numeric" dir="ltr" />}
        </Field>
        <Field
          label={t("serialModes.label")}
          error={errors.serialMode ?? errors.trackSerials}
          hint={unit?.allowsFraction ? t("catalog.errors.serialsWhole") : locked ? t("serialModes.relaxOnly") : t.dyn(`serialModes.hint.${v.serialMode}`)}
          className="sm:col-span-2"
        >
          {(p) => (
            <Select {...p} value={v.serialMode} onChange={(e) => setV((s) => ({ ...s, serialMode: e.target.value as SerialMode }))} disabled={!!unit?.allowsFraction && v.serialMode === "NONE"}>
              {SERIAL_MODES.map((m) => (
                <option key={m} value={m}>
                  {t(`serialModes.${m}`)}
                </option>
              ))}
            </Select>
          )}
        </Field>
        <Field label={t("catalog.products.description")} error={errors.description} className="sm:col-span-2">
          {(p) => <Textarea {...p} value={v.description} onChange={set("description")} rows={3} maxLength={2000} dir="auto" />}
        </Field>
        <div className="space-y-1 sm:col-span-2">
          {!v.barcode && !initial?.barcode && (
            <Checkbox label={t("codes.generateBarcode")} description={t("codes.generateBarcodeHint")} checked={v.generateBarcode} onChange={(e) => setV((s) => ({ ...s, generateBarcode: e.target.checked }))} />
          )}
          <Checkbox label={t("catalog.products.active")} description={t("catalog.products.activeHint")} checked={v.isActive} onChange={(e) => setV((s) => ({ ...s, isActive: e.target.checked }))} />
          {errors.isActive && (
            <p className="text-xs font-medium text-danger" role="alert">
              {t.msg(errors.isActive)}
            </p>
          )}
        </div>
        <div className="flex flex-wrap justify-end gap-2 sm:col-span-2">
          {creating && (
            <Button type="button" variant="outline" loading={busy} onClick={() => void submit(true)}>
              {t("forms.saveAndAddAnother")}
            </Button>
          )}
          <Button type="submit" loading={busy}>
            {initial ? t("common.saveChanges") : t("common.save")}
          </Button>
        </div>
      </form>
    </Card>
  );
}
