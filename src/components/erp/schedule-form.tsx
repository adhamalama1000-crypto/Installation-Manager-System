"use client";

import { useState } from "react";
import { Pencil, Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { Field, Input, Select, Textarea } from "@/components/ui/field";
import { useT } from "@/i18n/client";
import { api } from "@/lib/api-client";
import { STOCKTAKE_KINDS, STOCKTAKE_RECURRENCES } from "@/lib/stocktake-schedule";
import { ProductPicker } from "./document-form";
import { PeoplePicker } from "./stocktake-planning";
import { useAction } from "./use-action";

type Option = { id: string; label: string };
export type ScheduleValues = {
  id?: string;
  version?: number;
  name: string;
  nameAr: string;
  warehouseId: string;
  kind: string;
  recurrence: string;
  interval: string;
  startDate: string;
  endDate: string;
  startTime: string;
  durationMinutes: string;
  assigneeIds: string[];
  supervisorId: string;
  categoryIds: string[];
  products: { id: string; label: string }[];
  mandatory: boolean;
  instructions: string;
  status: string;
};

/** Create or edit a stocktake schedule (planners). */
export function ScheduleForm({
  initial,
  warehouses,
  people,
  categories,
}: {
  initial: ScheduleValues;
  warehouses: Option[];
  people: { id: string; name: string }[];
  categories: Option[];
}) {
  const t = useT();
  const { busy, errors, run } = useAction();
  const [open, setOpen] = useState(false);
  const [v, setV] = useState(initial);
  const [reason, setReason] = useState("");
  const set = (patch: Partial<ScheduleValues>) => setV((x) => ({ ...x, ...patch }));
  const editing = !!initial.id;

  async function save() {
    const body = {
      ...v,
      interval: Number(v.interval),
      durationMinutes: Number(v.durationMinutes),
      endDate: v.recurrence === "NONE" ? null : v.endDate || null,
      supervisorId: v.supervisorId || null,
      productIds: v.products.map((p) => p.id),
      reason,
    };
    const r = await run(
      () => (editing ? api(`/api/stocktake-schedules/${initial.id}`, { method: "PUT", body }) : api("/api/stocktake-schedules", { method: "POST", body })),
      () => t("stocktakePlan.scheduleSaved"),
    );
    if (r !== null) setOpen(false);
  }

  return (
    <>
      {editing ? (
        <Button size="sm" variant="ghost" onClick={() => setOpen(true)} aria-label={`${t("stocktakePlan.editSchedule")}: ${initial.name}`}>
          <Pencil className="h-3.5 w-3.5" /> {t("stocktakePlan.editSchedule")}
        </Button>
      ) : (
        <Button onClick={() => setOpen(true)}>
          <Plus className="h-4 w-4" /> {t("stocktakePlan.newSchedule")}
        </Button>
      )}
      <Dialog open={open} onClose={() => setOpen(false)} title={editing ? t("stocktakePlan.editSchedule") : t("stocktakePlan.newSchedule")} size="lg">
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <Field label={t("stocktakePlan.fields.name")} error={t.msg(errors.name)} required>
            {(p) => <Input {...p} value={v.name} onChange={(e) => set({ name: e.target.value })} maxLength={120} dir="auto" />}
          </Field>
          <Field label={t("stocktakePlan.fields.nameAr")}>{(p) => <Input {...p} value={v.nameAr} onChange={(e) => set({ nameAr: e.target.value })} maxLength={120} dir="rtl" />}</Field>
          <Field label={t("stocktakePlan.fields.warehouse")} error={t.msg(errors.warehouseId)}>
            {(p) => (
              <Select {...p} value={v.warehouseId} disabled={editing} onChange={(e) => set({ warehouseId: e.target.value })}>
                {warehouses.map((w) => (
                  <option key={w.id} value={w.id}>
                    {w.label}
                  </option>
                ))}
              </Select>
            )}
          </Field>
          <Field label={t("stocktakePlan.fields.kind")} error={t.msg(errors.kind)}>
            {(p) => (
              <Select
                {...p}
                value={v.kind}
                onChange={(e) => {
                  const kind = e.target.value;
                  // A sensible repetition for the type; it can still be changed.
                  set({ kind, recurrence: kind === "DAILY" ? "DAILY" : kind === "MONTHLY" ? "MONTHLY" : kind === "ANNUAL" ? "YEARLY" : v.recurrence });
                }}
              >
                {STOCKTAKE_KINDS.map((k) => (
                  <option key={k} value={k}>
                    {t.dyn(`stocktakePlan.kinds.${k}`)}
                  </option>
                ))}
              </Select>
            )}
          </Field>
          <Field label={t("stocktakePlan.fields.recurrence")} error={t.msg(errors.recurrence)}>
            {(p) => (
              <Select {...p} value={v.recurrence} onChange={(e) => set({ recurrence: e.target.value })}>
                {STOCKTAKE_RECURRENCES.map((r) => (
                  <option key={r} value={r}>
                    {t.dyn(`stocktakePlan.recurrences.${r}`)}
                  </option>
                ))}
              </Select>
            )}
          </Field>
          {v.recurrence !== "NONE" && (
            <Field label={t("stocktakePlan.fields.interval")} hint={t("stocktakePlan.hints.interval")} error={t.msg(errors.interval)}>
              {(p) => <Input {...p} inputMode="numeric" value={v.interval} onChange={(e) => set({ interval: e.target.value })} dir="ltr" />}
            </Field>
          )}
          <Field label={t("stocktakePlan.fields.startDate")} error={t.msg(errors.startDate)}>
            {(p) => <Input {...p} type="date" value={v.startDate} onChange={(e) => set({ startDate: e.target.value })} />}
          </Field>
          {v.recurrence !== "NONE" && (
            <Field label={t("stocktakePlan.fields.endDate")} error={t.msg(errors.endDate)}>
              {(p) => <Input {...p} type="date" value={v.endDate} onChange={(e) => set({ endDate: e.target.value })} />}
            </Field>
          )}
          <Field label={t("stocktakePlan.fields.startTime")} error={t.msg(errors.startTime)}>
            {(p) => <Input {...p} type="time" value={v.startTime} onChange={(e) => set({ startTime: e.target.value })} />}
          </Field>
          <Field label={t("stocktakePlan.fields.duration")} error={t.msg(errors.durationMinutes)}>
            {(p) => <Input {...p} inputMode="numeric" value={v.durationMinutes} onChange={(e) => set({ durationMinutes: e.target.value })} dir="ltr" />}
          </Field>
          <PeoplePicker label={t("stocktakePlan.fields.assignees")} hint={t("stocktakePlan.hints.assignees")} people={people} value={v.assigneeIds} onChange={(ids) => set({ assigneeIds: ids })} error={t.msg(errors.assigneeIds)} className="sm:col-span-2" />
          <Field label={t("stocktakePlan.fields.supervisor")} hint={t("stocktakePlan.hints.supervisor")} error={t.msg(errors.supervisorId)}>
            {(p) => (
              <Select {...p} value={v.supervisorId} onChange={(e) => set({ supervisorId: e.target.value })}>
                <option value="">{t("stocktakePlan.noSupervisor")}</option>
                {people.map((x) => (
                  <option key={x.id} value={x.id}>
                    {x.name}
                  </option>
                ))}
              </Select>
            )}
          </Field>
          <label className="flex items-center gap-2 self-end pb-2 text-sm">
            <input type="checkbox" className="h-4 w-4 accent-[var(--brand-strong)]" checked={v.mandatory} onChange={(e) => set({ mandatory: e.target.checked })} />
            {t("stocktakePlan.fields.mandatory")}
          </label>
          <fieldset className="sm:col-span-2">
            <legend className="mb-1 text-sm font-medium text-fg">{t("stocktakePlan.scope")}</legend>
            <p className="mb-2 text-xs text-fg-muted">{t("stocktakePlan.hints.scope")}</p>
            <div className="mb-2 flex max-h-32 flex-wrap gap-2 overflow-y-auto rounded-lg border border-line p-2" aria-label={t("stocktakePlan.fields.categories")} role="group">
              {categories.map((c) => (
                <label key={c.id} className="flex items-center gap-1.5 text-sm">
                  <input type="checkbox" className="h-4 w-4 accent-[var(--brand-strong)]" checked={v.categoryIds.includes(c.id)} onChange={(e) => set({ categoryIds: e.target.checked ? [...v.categoryIds, c.id] : v.categoryIds.filter((x) => x !== c.id) })} />
                  {c.label}
                </label>
              ))}
            </div>
            <ul className="mb-2 flex flex-wrap gap-2">
              {v.products.map((p) => (
                <li key={p.id}>
                  <button type="button" className="rounded-full border border-line px-2 py-0.5 text-xs hover:bg-surface-muted" onClick={() => set({ products: v.products.filter((x) => x.id !== p.id) })}>
                    {p.label} ×
                  </button>
                </li>
              ))}
            </ul>
            <ProductPicker label={t("stocktakePlan.fields.products")} warehouseId={v.warehouseId} onPick={(p) => !v.products.some((x) => x.id === p.id) && set({ products: [...v.products, { id: p.id, label: p.sku }] })} />
          </fieldset>
          <Field label={t("stocktakePlan.fields.instructions")} className="sm:col-span-2">
            {(p) => <Textarea {...p} rows={2} value={v.instructions} onChange={(e) => set({ instructions: e.target.value })} maxLength={2000} dir="auto" />}
          </Field>
          {editing && (
            <Field label={t("stocktakePlan.fields.status")}>
              {(p) => (
                <Select {...p} value={v.status} onChange={(e) => set({ status: e.target.value })}>
                  {["ACTIVE", "PAUSED", "ENDED"].map((s) => (
                    <option key={s} value={s}>
                      {t.dyn(`stocktakePlan.scheduleStatuses.${s}`)}
                    </option>
                  ))}
                </Select>
              )}
            </Field>
          )}
          <Field label={t("stocktakePlan.fields.reason")} className={editing ? "" : "sm:col-span-2"}>
            {(p) => <Input {...p} value={reason} onChange={(e) => setReason(e.target.value)} maxLength={500} dir="auto" />}
          </Field>
        </div>
        {errors._form && (
          <p className="mt-3 text-sm font-medium text-danger" role="alert">
            {t.msg(errors._form)}
          </p>
        )}
        <div className="mt-4 flex justify-end">
          <Button loading={busy} onClick={() => void save()}>
            {t("common.save")}
          </Button>
        </div>
      </Dialog>
    </>
  );
}
