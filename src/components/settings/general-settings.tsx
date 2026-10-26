"use client";

import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Checkbox, Field, Input, Select } from "@/components/ui/field";
import { useI18n } from "@/i18n/client";
import { api, ApiError } from "@/lib/api-client";
import type { SettingsValues } from "@/lib/validation";

const WEEKDAYS = [0, 1, 2, 3, 4, 5, 6];

export function GeneralSettings({ initial }: { initial: SettingsValues }) {
  const { t, tm, f } = useI18n();
  const router = useRouter();
  const [v, setV] = useState(initial);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);
  const zones = useMemo(() => {
    try {
      return Intl.supportedValuesOf("timeZone");
    } catch {
      return [initial.timezone];
    }
  }, [initial.timezone]);
  const upd = (patch: Partial<SettingsValues>) => setV((s) => ({ ...s, ...patch }));

  async function save(e: React.FormEvent) {
    e.preventDefault();
    setSaving(true);
    setErrors({});
    try {
      await api("/api/settings", { method: "PUT", body: v });
      toast.success(t("set.saved"));
      router.refresh();
    } catch (err) {
      setErrors((err as ApiError).fieldErrors ?? {});
      toast.error((err as ApiError).message);
    } finally {
      setSaving(false);
    }
  }

  return (
    <form onSubmit={save} className="space-y-6">
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        <Field label={t("set.companyName")} error={errors.companyName} hint={t("set.companyNameHint")}>
          {(p) => <Input {...p} maxLength={80} value={v.companyName} onChange={(e) => upd({ companyName: e.target.value })} />}
        </Field>
        <Field label={t("set.timezone")} error={errors.timezone} hint={t("set.timezoneHint")}>
          {(p) => (
            <Select {...p} dir="ltr" value={v.timezone} onChange={(e) => upd({ timezone: e.target.value })}>
              {zones.map((z) => (
                <option key={z} value={z}>
                  {z}
                </option>
              ))}
            </Select>
          )}
        </Field>
        <Field label={t("set.weekStarts")} error={errors.weekStartsOn}>
          {(p) => (
            <Select {...p} value={v.weekStartsOn} onChange={(e) => upd({ weekStartsOn: Number(e.target.value) })}>
              {WEEKDAYS.map((i) => (
                <option key={i} value={i}>
                  {f.weekday(i)}
                </option>
              ))}
            </Select>
          )}
        </Field>
        <Field label={t("set.defaultDuration")} error={errors.defaultDurationMinutes}>
          {(p) => <Input {...p} type="number" min={15} step={15} value={v.defaultDurationMinutes} onChange={(e) => upd({ defaultDurationMinutes: Number(e.target.value) })} />}
        </Field>
        <Field label={t("set.dayStart")} error={errors.dayStartHour}>
          {(p) => <Input {...p} type="number" min={0} max={23} value={v.dayStartHour} onChange={(e) => upd({ dayStartHour: Number(e.target.value) })} />}
        </Field>
        <Field label={t("set.dayEnd")} error={errors.dayEndHour}>
          {(p) => <Input {...p} type="number" min={1} max={24} value={v.dayEndHour} onChange={(e) => upd({ dayEndHour: Number(e.target.value) })} />}
        </Field>
        <Field label={t("set.buffer")} error={errors.travelBufferMinutes} hint={t("set.bufferHint")}>
          {(p) => <Input {...p} type="number" min={0} max={240} step={5} value={v.travelBufferMinutes} onChange={(e) => upd({ travelBufferMinutes: Number(e.target.value) })} />}
        </Field>
      </div>
      <fieldset>
        <legend className="mb-2 text-sm font-medium text-fg">{t("set.closedDays")}</legend>
        <p className="mb-2 text-xs text-fg-muted">{t("set.closedDaysHint")}</p>
        <div className="flex flex-wrap gap-2">
          {WEEKDAYS.map((i) => {
            const on = v.closedWeekdays.includes(i);
            return (
              <label key={i} className={`inline-flex cursor-pointer items-center gap-2 rounded-lg border px-3 py-1.5 text-sm ${on ? "border-brand bg-brand-soft text-fg" : "border-line text-fg-muted"}`}>
                <input
                  type="checkbox"
                  className="h-4 w-4 accent-[var(--brand-strong)]"
                  checked={on}
                  onChange={(e) => upd({ closedWeekdays: e.target.checked ? [...v.closedWeekdays, i].sort() : v.closedWeekdays.filter((x) => x !== i) })}
                />
                {f.weekday(i)}
              </label>
            );
          })}
        </div>
        {errors.closedWeekdays && <p className="mt-1 text-xs text-danger">{tm(errors.closedWeekdays)}</p>}
      </fieldset>
      <div className="grid gap-2 sm:grid-cols-3">
        <Checkbox label={t("set.salesReports")} checked={v.salesCanViewReports} onChange={(e) => upd({ salesCanViewReports: e.target.checked })} />
        <Checkbox
          label={t("set.salesEditAny")}
          description={t("set.salesEditAnyHint")}
          checked={v.salesCanEditOthersAppointments}
          onChange={(e) => upd({ salesCanEditOthersAppointments: e.target.checked })}
        />
        <Checkbox
          label={t("set.techContacts")}
          checked={v.technicianCanSeeContacts}
          onChange={(e) => upd({ technicianCanSeeContacts: e.target.checked })}
        />
      </div>
      <div className="flex justify-end">
        <Button type="submit" loading={saving}>
          {t("set.save")}
        </Button>
      </div>
    </form>
  );
}
