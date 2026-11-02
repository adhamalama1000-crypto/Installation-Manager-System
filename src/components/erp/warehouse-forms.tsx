"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Pencil, Plus } from "lucide-react";
import type { WarehouseKind } from "@prisma/client";
import { Button } from "@/components/ui/button";
import { Card, CardHeader } from "@/components/ui/card";
import { Dialog } from "@/components/ui/dialog";
import { Checkbox, Field, Input, Select } from "@/components/ui/field";
import { Badge, EmptyState } from "@/components/ui/misc";
import { useT } from "@/i18n/client";
import { api } from "@/lib/api-client";
import { WAREHOUSE_KINDS } from "@/lib/inventory";
import { useAction } from "./use-action";

export type WarehouseInitial = {
  id: string;
  version: number;
  code: string;
  nameEn: string;
  nameAr: string;
  kind: WarehouseKind;
  technicianId: string | null;
  address: string | null;
  allowNegative: boolean;
  isActive: boolean;
};
type Technician = { id: string; name: string; vehicle: { id: string; code: string } | null };

/** Create or edit a warehouse or a technician's vehicle (in a dialog). */
export function WarehouseDialogButton({ initial, technicians }: { initial?: WarehouseInitial; technicians: Technician[] }) {
  const t = useT();
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const blank = { code: "", nameEn: "", nameAr: "", kind: "WAREHOUSE" as WarehouseKind, technicianId: "", address: "", allowNegative: false, isActive: true };
  const [v, setV] = useState(blank);
  const { busy, errors, setErrors, run } = useAction();
  const show = () => {
    setErrors({});
    setV(initial ? { ...initial, technicianId: initial.technicianId ?? "", address: initial.address ?? "" } : blank);
    setOpen(true);
  };
  async function submit(e: React.FormEvent) {
    e.preventDefault();
    const body = { ...v, technicianId: v.kind === "VEHICLE" ? v.technicianId || null : null, ...(initial ? { version: initial.version } : {}) };
    const r = await run(
      () =>
        initial
          ? api<{ warehouse: { id: string } }>(`/api/warehouses/${initial.id}`, { method: "PATCH", body })
          : api<{ warehouse: { id: string } }>("/api/warehouses", { method: "POST", body }),
      () => t("warehouses.saved"),
      { refresh: !!initial },
    );
    if (!r) return;
    setOpen(false);
    if (!initial) router.push(`/warehouses/${r.warehouse.id}`);
  }
  return (
    <>
      <Button variant={initial ? "outline" : "primary"} onClick={show}>
        {initial ? <Pencil className="h-4 w-4" /> : <Plus className="h-4 w-4" />} {initial ? t("warehouses.editWarehouse") : t("warehouses.newWarehouse")}
      </Button>
      <Dialog
        open={open}
        onClose={() => setOpen(false)}
        size="lg"
        title={initial ? t("warehouses.editWarehouse") : t("warehouses.newWarehouse")}
        footer={
          <>
            <Button variant="ghost" onClick={() => setOpen(false)}>
              {t("common.cancel")}
            </Button>
            <Button type="submit" form="warehouse-form" loading={busy}>
              {t("common.save")}
            </Button>
          </>
        }
      >
        <form id="warehouse-form" className="grid grid-cols-1 gap-4 sm:grid-cols-2" noValidate onSubmit={submit}>
          <Field label={t("warehouses.code")} required hint={t("warehouses.codeHint")} error={errors.code}>
            {(p) => <Input {...p} value={v.code} onChange={(e) => setV({ ...v, code: e.target.value })} maxLength={20} dir="ltr" className="font-mono" />}
          </Field>
          <Field label={t("warehouses.kind")} required error={errors.kind}>
            {(p) => (
              <Select {...p} value={v.kind} onChange={(e) => setV({ ...v, kind: e.target.value as WarehouseKind })}>
                {WAREHOUSE_KINDS.map((k) => (
                  <option key={k} value={k}>
                    {t.dyn(`enums.warehouseKind.${k}`)}
                  </option>
                ))}
              </Select>
            )}
          </Field>
          <Field label={t("catalog.nameEn")} required error={errors.nameEn}>
            {(p) => <Input {...p} value={v.nameEn} onChange={(e) => setV({ ...v, nameEn: e.target.value })} maxLength={100} dir="ltr" />}
          </Field>
          <Field label={t("catalog.nameAr")} required error={errors.nameAr}>
            {(p) => <Input {...p} value={v.nameAr} onChange={(e) => setV({ ...v, nameAr: e.target.value })} maxLength={100} dir="rtl" />}
          </Field>
          {v.kind === "VEHICLE" && (
            <Field label={t("warehouses.technician")} required hint={t("warehouses.technicianHint")} error={errors.technicianId} className="sm:col-span-2">
              {(p) => (
                <Select {...p} value={v.technicianId} onChange={(e) => setV({ ...v, technicianId: e.target.value })}>
                  <option value="">{t("warehouses.noTechnician")}</option>
                  {technicians.map((tech) => {
                    const taken = !!tech.vehicle && tech.vehicle.id !== initial?.id;
                    return (
                      <option key={tech.id} value={tech.id} disabled={taken}>
                        {tech.name}
                        {taken ? ` (${t("warehouses.hasVehicle", { code: tech.vehicle!.code })})` : ""}
                      </option>
                    );
                  })}
                </Select>
              )}
            </Field>
          )}
          <Field label={t("warehouses.address")} error={errors.address} className="sm:col-span-2">
            {(p) => <Input {...p} value={v.address} onChange={(e) => setV({ ...v, address: e.target.value })} maxLength={300} dir="auto" />}
          </Field>
          <div className="space-y-1 sm:col-span-2">
            <Checkbox label={t("warehouses.allowNegative")} description={errors.allowNegative ? t.msg(errors.allowNegative) : t("warehouses.allowNegativeHint")} checked={v.allowNegative} onChange={(e) => setV({ ...v, allowNegative: e.target.checked })} />
            <Checkbox label={t("warehouses.active")} description={errors.isActive ? t.msg(errors.isActive) : t("warehouses.activeHint")} checked={v.isActive} onChange={(e) => setV({ ...v, isActive: e.target.checked })} />
          </div>
        </form>
      </Dialog>
    </>
  );
}

type Bin = { id: string; code: string; name: string | null; isActive: boolean; productCount: number };

export function BinsManager({ warehouseId, bins, manage }: { warehouseId: string; bins: Bin[]; manage: boolean }) {
  const t = useT();
  const [editing, setEditing] = useState<{ open: boolean; bin: Bin | null }>({ open: false, bin: null });
  const [v, setV] = useState({ code: "", name: "", isActive: true });
  const { busy, errors, setErrors, run } = useAction();
  const open = (b: Bin | null) => {
    setErrors({});
    setV(b ? { code: b.code, name: b.name ?? "", isActive: b.isActive } : { code: "", name: "", isActive: true });
    setEditing({ open: true, bin: b });
  };
  return (
    <Card>
      <CardHeader
        title={t("warehouses.binsTitle")}
        description={t("warehouses.binCount", { count: bins.length })}
        actions={
          manage && (
            <Button size="sm" variant="outline" onClick={() => open(null)}>
              <Plus className="h-4 w-4" /> {t("warehouses.bins.add")}
            </Button>
          )
        }
      />
      {bins.length === 0 ? (
        <EmptyState title={t("warehouses.noBins")} />
      ) : (
        <ul className="divide-y divide-line">
          {bins.map((b) => (
            <li key={b.id} className="flex items-center gap-3 px-5 py-2.5">
              <div className="min-w-0 flex-1">
                <p className="text-sm font-medium text-fg">
                  <bdi className="font-mono">{b.code}</bdi> {b.name && <span className="text-fg-muted">· {b.name}</span>} {!b.isActive && <Badge>{t("common.inactive")}</Badge>}
                </p>
                <p className="text-xs text-fg-subtle">
                  {t("warehouses.bins.inStock")}: {b.productCount}
                </p>
              </div>
              {manage && (
                <Button variant="ghost" size="sm" onClick={() => open(b)} aria-label={`${t("warehouses.bins.edit")} ${b.code}`}>
                  <Pencil className="h-3.5 w-3.5" />
                </Button>
              )}
            </li>
          ))}
        </ul>
      )}
      <Dialog
        open={editing.open}
        onClose={() => setEditing({ open: false, bin: null })}
        title={editing.bin ? t("warehouses.bins.edit") : t("warehouses.bins.add")}
        size="sm"
        footer={
          <>
            <Button variant="ghost" onClick={() => setEditing({ open: false, bin: null })}>
              {t("common.cancel")}
            </Button>
            <Button type="submit" form="bin-form" loading={busy}>
              {t("common.save")}
            </Button>
          </>
        }
      >
        <form
          id="bin-form"
          className="space-y-4"
          noValidate
          onSubmit={async (e) => {
            e.preventDefault();
            const r = await run(
              () =>
                editing.bin
                  ? api(`/api/warehouses/${warehouseId}/bins/${editing.bin.id}`, { method: "PATCH", body: v })
                  : api(`/api/warehouses/${warehouseId}/bins`, { method: "POST", body: v }),
              () => t("warehouses.bins.saved"),
            );
            if (r) setEditing({ open: false, bin: null });
          }}
        >
          <Field label={t("warehouses.bins.code")} required hint={t("warehouses.codeHint")} error={errors.code}>
            {(p) => <Input {...p} value={v.code} onChange={(e) => setV({ ...v, code: e.target.value })} maxLength={20} dir="ltr" className="font-mono" />}
          </Field>
          <Field label={t("warehouses.bins.name")} error={errors.name}>
            {(p) => <Input {...p} value={v.name} onChange={(e) => setV({ ...v, name: e.target.value })} maxLength={100} dir="auto" />}
          </Field>
          <Checkbox label={t("common.active")} description={errors.isActive ? t.msg(errors.isActive) : undefined} checked={v.isActive} onChange={(e) => setV({ ...v, isActive: e.target.checked })} />
        </form>
      </Dialog>
    </Card>
  );
}
