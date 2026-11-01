"use client";

import { useState } from "react";
import { Pencil, Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardHeader } from "@/components/ui/card";
import { Dialog } from "@/components/ui/dialog";
import { Checkbox, Field, Input, Select } from "@/components/ui/field";
import { Badge, EmptyState } from "@/components/ui/misc";
import { useT } from "@/i18n/client";
import { api } from "@/lib/api-client";
import { nameOf } from "./labels";
import { useAction } from "./use-action";

type Unit = { id: string; code: string; nameEn: string; nameAr: string; allowsFraction: boolean; isActive: boolean; sortOrder: number; productCount: number };
type Category = { id: string; nameEn: string; nameAr: string; parentId: string | null; isActive: boolean; sortOrder: number; productCount: number };
type Brand = { id: string; name: string; isActive: boolean; productCount: number };

type Editing<T> = { open: boolean; item: T | null };

function EditButton({ label, onClick }: { label: string; onClick: () => void }) {
  return (
    <Button variant="ghost" size="sm" onClick={onClick} aria-label={label} title={label}>
      <Pencil className="h-3.5 w-3.5" />
    </Button>
  );
}

function Row({ title, sub, inactive, count, edit, indent }: { title: React.ReactNode; sub?: React.ReactNode; inactive: boolean; count: number; edit: React.ReactNode; indent?: boolean }) {
  const t = useT();
  return (
    <li className={indent ? "flex items-center gap-3 py-2.5 pe-5 ps-10" : "flex items-center gap-3 px-5 py-2.5"}>
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm font-medium text-fg">
          {title} {inactive && <Badge>{t("common.inactive")}</Badge>}
        </p>
        {sub && <p className="truncate text-xs text-fg-subtle">{sub}</p>}
      </div>
      <span className="text-xs tabular-nums text-fg-subtle" title={t("catalog.units.products")}>
        {count}
      </span>
      {edit}
    </li>
  );
}

function Footer({ onCancel, busy }: { onCancel: () => void; busy: boolean }) {
  const t = useT();
  return (
    <>
      <Button variant="ghost" onClick={onCancel}>
        {t("common.cancel")}
      </Button>
      <Button type="submit" form="catalog-entry" loading={busy}>
        {t("common.save")}
      </Button>
    </>
  );
}

export function UnitsManager({ units }: { units: Unit[] }) {
  const t = useT();
  const [state, setState] = useState<Editing<Unit>>({ open: false, item: null });
  const [v, setV] = useState({ code: "", nameEn: "", nameAr: "", allowsFraction: false, isActive: true, sortOrder: "0" });
  const { busy, errors, setErrors, run } = useAction();
  const open = (u: Unit | null) => {
    setErrors({});
    setV(u ? { code: u.code, nameEn: u.nameEn, nameAr: u.nameAr, allowsFraction: u.allowsFraction, isActive: u.isActive, sortOrder: String(u.sortOrder) } : { code: "", nameEn: "", nameAr: "", allowsFraction: false, isActive: true, sortOrder: String((units.length + 1) * 10) });
    setState({ open: true, item: u });
  };
  return (
    <Card>
      <CardHeader
        title={t("catalog.units.title")}
        actions={
          <Button size="sm" variant="outline" onClick={() => open(null)}>
            <Plus className="h-4 w-4" /> {t("catalog.units.add")}
          </Button>
        }
      />
      <ul className="divide-y divide-line">
        {units.map((u) => (
          <Row
            key={u.id}
            title={
              <>
                <bdi className="font-mono">{u.code}</bdi> · {nameOf(u, t)}
              </>
            }
            sub={u.allowsFraction ? t("catalog.units.allowsFraction") : undefined}
            inactive={!u.isActive}
            count={u.productCount}
            edit={<EditButton label={t("catalog.units.edit")} onClick={() => open(u)} />}
          />
        ))}
      </ul>
      <Dialog open={state.open} onClose={() => setState({ open: false, item: null })} title={state.item ? t("catalog.units.edit") : t("catalog.units.add")} footer={<Footer busy={busy} onCancel={() => setState({ open: false, item: null })} />}>
        <form
          id="catalog-entry"
          className="grid grid-cols-1 gap-4 sm:grid-cols-2"
          noValidate
          onSubmit={async (e) => {
            e.preventDefault();
            const r = await run(
              () => (state.item ? api(`/api/catalog/units/${state.item.id}`, { method: "PATCH", body: v }) : api("/api/catalog/units", { method: "POST", body: v })),
              () => t("catalog.savedEntry"),
            );
            if (r) setState({ open: false, item: null });
          }}
        >
          <Field label={t("catalog.units.code")} required error={errors.code}>
            {(p) => <Input {...p} value={v.code} onChange={(e) => setV({ ...v, code: e.target.value })} maxLength={16} dir="ltr" className="font-mono" />}
          </Field>
          <Field label={t("catalog.units.sortOrder")} error={errors.sortOrder}>
            {(p) => <Input {...p} value={v.sortOrder} onChange={(e) => setV({ ...v, sortOrder: e.target.value })} inputMode="numeric" dir="ltr" />}
          </Field>
          <Field label={t("catalog.nameEn")} required error={errors.nameEn}>
            {(p) => <Input {...p} value={v.nameEn} onChange={(e) => setV({ ...v, nameEn: e.target.value })} maxLength={60} dir="ltr" />}
          </Field>
          <Field label={t("catalog.nameAr")} required error={errors.nameAr}>
            {(p) => <Input {...p} value={v.nameAr} onChange={(e) => setV({ ...v, nameAr: e.target.value })} maxLength={60} dir="rtl" />}
          </Field>
          <div className="sm:col-span-2">
            <Checkbox label={t("catalog.units.allowsFraction")} description={errors.allowsFraction ? t.msg(errors.allowsFraction) : t("catalog.units.fractionHint")} checked={v.allowsFraction} onChange={(e) => setV({ ...v, allowsFraction: e.target.checked })} />
            <Checkbox label={t("common.active")} checked={v.isActive} onChange={(e) => setV({ ...v, isActive: e.target.checked })} />
          </div>
        </form>
      </Dialog>
    </Card>
  );
}

export function CategoriesManager({ categories }: { categories: Category[] }) {
  const t = useT();
  const [state, setState] = useState<Editing<Category>>({ open: false, item: null });
  const [v, setV] = useState({ nameEn: "", nameAr: "", parentId: "", isActive: true, sortOrder: "0" });
  const { busy, errors, setErrors, run } = useAction();
  const tops = categories.filter((c) => !c.parentId);
  const open = (c: Category | null, parentId = "") => {
    setErrors({});
    setV(c ? { nameEn: c.nameEn, nameAr: c.nameAr, parentId: c.parentId ?? "", isActive: c.isActive, sortOrder: String(c.sortOrder) } : { nameEn: "", nameAr: "", parentId, isActive: true, sortOrder: "0" });
    setState({ open: true, item: c });
  };
  const hasChildren = (id: string) => categories.some((c) => c.parentId === id);
  return (
    <Card>
      <CardHeader
        title={t("catalog.categories.title")}
        actions={
          <Button size="sm" variant="outline" onClick={() => open(null)}>
            <Plus className="h-4 w-4" /> {t("catalog.categories.add")}
          </Button>
        }
      />
      {tops.length === 0 ? (
        <EmptyState title={t("catalog.setupEmpty")} />
      ) : (
        <ul className="divide-y divide-line">
          {tops.flatMap((c) => [
            <Row key={c.id} title={nameOf(c, t)} inactive={!c.isActive} count={c.productCount} edit={<EditButton label={t("catalog.categories.edit")} onClick={() => open(c)} />} />,
            ...categories
              .filter((s) => s.parentId === c.id)
              .map((s) => (
                <Row
                  key={s.id}
                  indent
                  title={nameOf(s, t)}
                  sub={t("catalog.categories.subOf", { parent: nameOf(c, t) })}
                  inactive={!s.isActive}
                  count={s.productCount}
                  edit={<EditButton label={t("catalog.categories.edit")} onClick={() => open(s)} />}
                />
              )),
          ])}
        </ul>
      )}
      <Dialog open={state.open} onClose={() => setState({ open: false, item: null })} title={state.item ? t("catalog.categories.edit") : t("catalog.categories.add")} footer={<Footer busy={busy} onCancel={() => setState({ open: false, item: null })} />}>
        <form
          id="catalog-entry"
          className="grid grid-cols-1 gap-4 sm:grid-cols-2"
          noValidate
          onSubmit={async (e) => {
            e.preventDefault();
            const body = { ...v, parentId: v.parentId || null };
            const r = await run(
              () => (state.item ? api(`/api/catalog/categories/${state.item.id}`, { method: "PATCH", body }) : api("/api/catalog/categories", { method: "POST", body })),
              () => t("catalog.savedEntry"),
            );
            if (r) setState({ open: false, item: null });
          }}
        >
          <Field label={t("catalog.nameEn")} required error={errors.nameEn}>
            {(p) => <Input {...p} value={v.nameEn} onChange={(e) => setV({ ...v, nameEn: e.target.value })} maxLength={100} dir="ltr" />}
          </Field>
          <Field label={t("catalog.nameAr")} required error={errors.nameAr}>
            {(p) => <Input {...p} value={v.nameAr} onChange={(e) => setV({ ...v, nameAr: e.target.value })} maxLength={100} dir="rtl" />}
          </Field>
          <Field label={t("catalog.categories.parent")} error={errors.parentId}>
            {(p) => (
              <Select {...p} value={v.parentId} onChange={(e) => setV({ ...v, parentId: e.target.value })} disabled={!!state.item && hasChildren(state.item.id)}>
                <option value="">{t("catalog.categories.topLevel")}</option>
                {tops
                  .filter((c) => c.id !== state.item?.id && (c.isActive || c.id === v.parentId))
                  .map((c) => (
                    <option key={c.id} value={c.id}>
                      {nameOf(c, t)}
                    </option>
                  ))}
              </Select>
            )}
          </Field>
          <Field label={t("catalog.units.sortOrder")} error={errors.sortOrder}>
            {(p) => <Input {...p} value={v.sortOrder} onChange={(e) => setV({ ...v, sortOrder: e.target.value })} inputMode="numeric" dir="ltr" />}
          </Field>
          <div className="sm:col-span-2">
            <Checkbox label={t("common.active")} checked={v.isActive} onChange={(e) => setV({ ...v, isActive: e.target.checked })} />
          </div>
        </form>
      </Dialog>
    </Card>
  );
}

export function BrandsManager({ brands }: { brands: Brand[] }) {
  const t = useT();
  const [state, setState] = useState<Editing<Brand>>({ open: false, item: null });
  const [v, setV] = useState({ name: "", isActive: true });
  const { busy, errors, setErrors, run } = useAction();
  const open = (b: Brand | null) => {
    setErrors({});
    setV(b ? { name: b.name, isActive: b.isActive } : { name: "", isActive: true });
    setState({ open: true, item: b });
  };
  return (
    <Card>
      <CardHeader
        title={t("catalog.brands.title")}
        actions={
          <Button size="sm" variant="outline" onClick={() => open(null)}>
            <Plus className="h-4 w-4" /> {t("catalog.brands.add")}
          </Button>
        }
      />
      {brands.length === 0 ? (
        <EmptyState title={t("catalog.setupEmpty")} />
      ) : (
        <ul className="divide-y divide-line">
          {brands.map((b) => (
            <Row key={b.id} title={b.name} inactive={!b.isActive} count={b.productCount} edit={<EditButton label={t("catalog.brands.edit")} onClick={() => open(b)} />} />
          ))}
        </ul>
      )}
      <Dialog open={state.open} onClose={() => setState({ open: false, item: null })} title={state.item ? t("catalog.brands.edit") : t("catalog.brands.add")} footer={<Footer busy={busy} onCancel={() => setState({ open: false, item: null })} />}>
        <form
          id="catalog-entry"
          className="space-y-4"
          noValidate
          onSubmit={async (e) => {
            e.preventDefault();
            const r = await run(
              () => (state.item ? api(`/api/catalog/brands/${state.item.id}`, { method: "PATCH", body: v }) : api("/api/catalog/brands", { method: "POST", body: v })),
              () => t("catalog.savedEntry"),
            );
            if (r) setState({ open: false, item: null });
          }}
        >
          <Field label={t("catalog.brands.name")} required error={errors.name}>
            {(p) => <Input {...p} value={v.name} onChange={(e) => setV({ ...v, name: e.target.value })} maxLength={100} dir="auto" />}
          </Field>
          <Checkbox label={t("common.active")} checked={v.isActive} onChange={(e) => setV({ ...v, isActive: e.target.checked })} />
        </form>
      </Dialog>
    </Card>
  );
}
