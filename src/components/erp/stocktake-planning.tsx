"use client";

import { useRef, useState } from "react";
import { Camera, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardHeader } from "@/components/ui/card";
import { Field, Input, Select, Textarea } from "@/components/ui/field";
import { Dialog } from "@/components/ui/dialog";
import { useT } from "@/i18n/client";
import { api, apiUpload } from "@/lib/api-client";
import { preparePhoto } from "@/lib/image";
import { ConfirmButton } from "./confirm-dialog";
import { useAction } from "./use-action";

type Person = { id: string; name: string };

/** A planned session: when, who, what; start it, change or postpone it, or cancel it. */
export function PlannedPanel({
  id,
  number,
  version,
  date,
  startTime,
  durationMinutes,
  assigneeIds,
  supervisorId,
  instructions,
  mandatory,
  people,
  can,
}: {
  id: string;
  number: string;
  version: number;
  date: string;
  startTime: string;
  durationMinutes: number;
  assigneeIds: string[];
  supervisorId: string | null;
  instructions: string | null;
  mandatory: boolean;
  people: Person[];
  can: { start: boolean; editPlan: boolean; cancel: boolean };
}) {
  const t = useT();
  const { busy, errors, run } = useAction();
  const [open, setOpen] = useState(false);
  const [v, setV] = useState({ date, startTime, durationMinutes: String(durationMinutes), assigneeIds, supervisorId: supervisorId ?? "", instructions: instructions ?? "", reason: "" });
  const act = (path: string, body: unknown, done: string, method: "POST" | "PUT" = "POST") => run(() => api(`/api/stocktakes/${id}/${path}`, { method, body }), () => done).then((r) => r !== null);

  return (
    <div className="mb-6 flex flex-wrap justify-end gap-2">
      {can.cancel && (
        <ConfirmButton
          variant="ghost"
          label={t("stocktakes.cancel")}
          title={t("stocktakes.cancelTitle", { number })}
          text={t("stocktakes.cancelText")}
          confirmLabel={t("stocktakes.cancel")}
          reason={{ label: mandatory ? t("stocktakePlan.errors.mandatoryCancel") : t("common.noteOptional"), required: mandatory }}
          busy={busy}
          error={errors.note}
          onConfirm={(note) => act("cancel", { note }, t("stocktakes.cancelledMsg"))}
        />
      )}
      {can.editPlan && (
        <Button variant="outline" onClick={() => setOpen(true)}>
          {t("stocktakePlan.editPlan")}
        </Button>
      )}
      {can.start && (
        <ConfirmButton
          label={t("stocktakePlan.start")}
          title={t("stocktakePlan.startTitle", { number })}
          text={t("stocktakePlan.startText")}
          confirmLabel={t("stocktakePlan.start")}
          busy={busy}
          error={errors._form}
          onConfirm={() => act("start", {}, t("stocktakePlan.started"))}
        />
      )}
      <Dialog open={open} onClose={() => setOpen(false)} title={t("stocktakePlan.editPlan")} size="lg">
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
          <Field label={t("stocktakePlan.fields.startDate")} error={t.msg(errors.date)}>
            {(p) => <Input {...p} type="date" value={v.date} onChange={(e) => setV({ ...v, date: e.target.value })} />}
          </Field>
          <Field label={t("stocktakePlan.fields.startTime")} error={t.msg(errors.startTime)}>
            {(p) => <Input {...p} type="time" value={v.startTime} onChange={(e) => setV({ ...v, startTime: e.target.value })} />}
          </Field>
          <Field label={t("stocktakePlan.fields.duration")} error={t.msg(errors.durationMinutes)}>
            {(p) => <Input {...p} inputMode="numeric" value={v.durationMinutes} onChange={(e) => setV({ ...v, durationMinutes: e.target.value })} dir="ltr" />}
          </Field>
          <PeoplePicker label={t("stocktakePlan.fields.assignees")} hint={t("stocktakePlan.hints.assignees")} people={people} value={v.assigneeIds} onChange={(ids) => setV({ ...v, assigneeIds: ids })} error={t.msg(errors.assigneeIds)} className="sm:col-span-2" />
          <Field label={t("stocktakePlan.fields.supervisor")} error={t.msg(errors.supervisorId)}>
            {(p) => (
              <Select {...p} value={v.supervisorId} onChange={(e) => setV({ ...v, supervisorId: e.target.value })}>
                <option value="">{t("stocktakePlan.noSupervisor")}</option>
                {people.map((x) => (
                  <option key={x.id} value={x.id}>
                    {x.name}
                  </option>
                ))}
              </Select>
            )}
          </Field>
          <Field label={t("stocktakePlan.fields.instructions")} className="sm:col-span-3">
            {(p) => <Textarea {...p} rows={2} value={v.instructions} onChange={(e) => setV({ ...v, instructions: e.target.value })} maxLength={2000} dir="auto" />}
          </Field>
          <Field label={t("stocktakePlan.fields.reason")} error={t.msg(errors.reason)} className="sm:col-span-3">
            {(p) => <Input {...p} value={v.reason} onChange={(e) => setV({ ...v, reason: e.target.value })} maxLength={500} dir="auto" />}
          </Field>
        </div>
        <div className="mt-4 flex justify-end">
          <Button
            loading={busy}
            onClick={async () => {
              const ok = await act("plan", { ...v, durationMinutes: Number(v.durationMinutes), supervisorId: v.supervisorId || null, version }, t("stocktakePlan.planSaved"), "PUT");
              if (ok) setOpen(false);
            }}
          >
            {t("common.save")}
          </Button>
        </div>
      </Dialog>
    </div>
  );
}

/** Tick boxes for choosing several people. */
export function PeoplePicker({ label, hint, people, value, onChange, error, className }: { label: string; hint?: string; people: Person[]; value: string[]; onChange: (ids: string[]) => void; error?: string; className?: string }) {
  return (
    <fieldset className={className}>
      <legend className="mb-1 text-sm font-medium text-fg">{label}</legend>
      {hint && <p className="mb-1 text-xs text-fg-muted">{hint}</p>}
      <div className="flex max-h-40 flex-wrap gap-2 overflow-y-auto rounded-lg border border-line p-2">
        {people.map((p) => (
          <label key={p.id} className="flex items-center gap-1.5 text-sm">
            <input type="checkbox" className="h-4 w-4 accent-[var(--brand-strong)]" checked={value.includes(p.id)} onChange={(e) => onChange(e.target.checked ? [...value, p.id] : value.filter((x) => x !== p.id))} />
            {p.name}
          </label>
        ))}
      </div>
      {error && (
        <p className="mt-1 text-xs font-medium text-danger" role="alert">
          {error}
        </p>
      )}
    </fieldset>
  );
}

/** Supporting photos of a stocktake (shrunk in the browser; location data removed). */
export function StocktakePhotos({ id, photos, canAdd }: { id: string; photos: { id: string; url: string; uploadedBy: string; canRemove: boolean }[]; canAdd: boolean }) {
  const t = useT();
  const { busy, run } = useAction();
  const input = useRef<HTMLInputElement>(null);
  if (!canAdd && !photos.length) return null;
  return (
    <Card className="mt-6">
      <CardHeader
        title={t("stocktakePlan.photos")}
        actions={
          canAdd && (
            <>
              <input
                ref={input}
                type="file"
                accept="image/*"
                className="sr-only"
                tabIndex={-1}
                aria-hidden
                onChange={async (e) => {
                  const file = e.target.files?.[0];
                  e.target.value = "";
                  if (!file) return;
                  await run(async () => apiUpload(`/api/stocktakes/${id}/photos`, await preparePhoto(file)), () => t("stocktakePlan.photoAdded"));
                }}
              />
              <Button size="sm" variant="outline" loading={busy} onClick={() => input.current?.click()}>
                <Camera className="h-4 w-4" /> {t("stocktakePlan.addPhoto")}
              </Button>
            </>
          )
        }
      />
      {photos.length === 0 ? (
        <p className="px-5 pb-5 text-sm text-fg-muted">{t("stocktakePlan.noPhotos")}</p>
      ) : (
        <ul className="grid grid-cols-2 gap-3 px-5 pb-5 sm:grid-cols-4">
          {photos.map((p) => (
            <li key={p.id} className="relative">
              <a href={p.url} target="_blank" rel="noreferrer">
                {/* eslint-disable-next-line @next/next/no-img-element -- permission-checked file route */}
                <img src={p.url} alt={`${t("stocktakePlan.photos")} · ${p.uploadedBy}`} className="aspect-square w-full rounded-lg border border-line object-cover" />
              </a>
              {p.canRemove && (
                <Button size="sm" variant="ghost" className="absolute end-1 top-1 bg-surface/90" aria-label={t("stocktakePlan.removePhoto")} onClick={() => void run(() => api(`/api/stocktake-photos/${p.id}`, { method: "DELETE" }), () => null)}>
                  <Trash2 className="h-3.5 w-3.5" />
                </Button>
              )}
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}
