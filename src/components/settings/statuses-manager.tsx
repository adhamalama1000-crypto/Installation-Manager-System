"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Pencil, Plus } from "lucide-react";
import type { StatusKind } from "@prisma/client";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { Checkbox, Field, Input, Select } from "@/components/ui/field";
import { Alert, Badge, StatusBadge } from "@/components/ui/misc";
import { useI18n } from "@/i18n/client";
import { api, ApiError } from "@/lib/api-client";
import { STATUS_KINDS } from "@/lib/constants";
import type { StatusDTO } from "@/lib/types";

type Draft = Omit<StatusDTO, "id" | "nameAr"> & { id?: string; nameAr: string };

export function StatusesManager({ statuses }: { statuses: StatusDTO[] }) {
  const { t, label, sn } = useI18n();
  const router = useRouter();
  const [draft, setDraft] = useState<Draft | null>(null);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);
  const upd = (p: Partial<Draft>) => setDraft((d) => (d ? { ...d, ...p } : d));

  async function save() {
    if (!draft) return;
    setSaving(true);
    setErrors({});
    try {
      const { id, ...body } = draft;
      if (id) await api(`/api/statuses/${id}`, { method: "PATCH", body });
      else await api("/api/statuses", { method: "POST", body });
      toast.success(t("set.statusSaved"));
      setDraft(null);
      router.refresh();
    } catch (e) {
      const err = e as ApiError;
      setErrors(Object.keys(err.fieldErrors).length ? err.fieldErrors : { _form: err.message });
      toast.error(err.message);
    } finally {
      setSaving(false);
    }
  }

  return (
    <>
      <ul className="divide-y divide-line">
        {statuses.map((s) => (
          <li key={s.id} className="flex flex-wrap items-center gap-3 px-5 py-3">
            <StatusBadge name={sn(s)} color={s.color} />
            <span className="text-xs text-fg-subtle">{label("statusKind", s.kind)}</span>
            {s.isDefault && <Badge className="border-brand/40 bg-brand-soft text-brand-text">{t("set.default")}</Badge>}
            {!s.blocksSchedule && <Badge>{t("set.freesTechnicians")}</Badge>}
            {!s.isActive && <Badge>{t("common.inactive")}</Badge>}
            <Button
              variant="ghost"
              size="sm"
              className="ms-auto"
              onClick={() => {
                setErrors({});
                setDraft({ ...s, nameAr: s.nameAr ?? "" });
              }}
            >
              <Pencil className="h-3.5 w-3.5" /> {t("common.edit")}
            </Button>
          </li>
        ))}
      </ul>
      <div className="border-t border-line px-5 py-3">
        <Button
          variant="outline"
          size="sm"
          onClick={() => {
            setErrors({});
            setDraft({ name: "", nameAr: "", kind: "SCHEDULED", color: "#2563EB", blocksSchedule: true, isDefault: false, isActive: true, sortOrder: (statuses.at(-1)?.sortOrder ?? 0) + 10 });
          }}
        >
          <Plus className="h-4 w-4" /> {t("set.addStatus")}
        </Button>
      </div>
      <Dialog
        open={Boolean(draft)}
        onClose={() => setDraft(null)}
        title={draft?.id ? t("set.editStatus") : t("set.addStatus")}
        footer={
          <>
            <Button variant="outline" onClick={() => setDraft(null)} disabled={saving}>
              {t("common.cancel")}
            </Button>
            <Button onClick={save} loading={saving}>
              {t("common.save")}
            </Button>
          </>
        }
      >
        {draft && (
          <div className="space-y-4">
            {errors._form && <Alert tone="danger">{errors._form}</Alert>}
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label={t("set.statusName")} required error={errors.name}>
                {(p) => <Input {...p} dir="ltr" value={draft.name} onChange={(e) => upd({ name: e.target.value })} />}
              </Field>
              <Field label={t("set.statusNameAr")} error={errors.nameAr} hint={t("set.statusNameArHint")}>
                {(p) => <Input {...p} dir="rtl" lang="ar" value={draft.nameAr} onChange={(e) => upd({ nameAr: e.target.value })} />}
              </Field>
              <Field label={t("set.meaning")} error={errors.kind} hint={t("set.meaningHint")}>
                {(p) => (
                  <Select {...p} value={draft.kind} onChange={(e) => upd({ kind: e.target.value as StatusKind, blocksSchedule: e.target.value !== "CANCELLED" })}>
                    {STATUS_KINDS.map((k) => (
                      <option key={k} value={k}>
                        {label("statusKind", k)}
                      </option>
                    ))}
                  </Select>
                )}
              </Field>
              <Field label={t("set.colour")} error={errors.color}>
                {(p) => (
                  <div className="flex gap-2">
                    <input type="color" value={draft.color} onChange={(e) => upd({ color: e.target.value.toUpperCase() })} className="h-10 w-12 cursor-pointer rounded border border-line" aria-label={t("set.pickColour")} />
                    <Input {...p} dir="ltr" value={draft.color} onChange={(e) => upd({ color: e.target.value })} className="font-mono" />
                  </div>
                )}
              </Field>
              <Field label={t("set.sortOrder")} error={errors.sortOrder}>
                {(p) => <Input {...p} type="number" value={draft.sortOrder} onChange={(e) => upd({ sortOrder: Number(e.target.value) })} />}
              </Field>
            </div>
            <Checkbox
              label={t("set.blocks")}
              description={t("set.blocksHint")}
              checked={draft.blocksSchedule}
              onChange={(e) => upd({ blocksSchedule: e.target.checked })}
            />
            {errors.blocksSchedule && <Alert tone="danger">{errors.blocksSchedule}</Alert>}
            <Checkbox label={t("set.defaultForNew")} checked={draft.isDefault} onChange={(e) => upd({ isDefault: e.target.checked })} />
            <Checkbox label={t("set.activeSelectable")} checked={draft.isActive} onChange={(e) => upd({ isActive: e.target.checked })} />
            {errors.isActive && <Alert tone="danger">{errors.isActive}</Alert>}
          </div>
        )}
      </Dialog>
    </>
  );
}
