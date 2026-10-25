"use client";

import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Checkbox, Field, Input, Select } from "@/components/ui/field";
import { api, ApiError } from "@/lib/api-client";
import type { SettingsValues } from "@/lib/validation";

const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

export function GeneralSettings({ initial }: { initial: SettingsValues }) {
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
      toast.success("Settings saved");
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
        <Field label="Company name" error={errors.companyName} hint="Used in WhatsApp reminders to customers.">
          {(p) => <Input {...p} maxLength={80} value={v.companyName} onChange={(e) => upd({ companyName: e.target.value })} />}
        </Field>
        <Field label="Company timezone" error={errors.timezone} hint="All dates and times are entered and shown in this timezone.">
          {(p) => (
            <Select {...p} value={v.timezone} onChange={(e) => upd({ timezone: e.target.value })}>
              {zones.map((z) => (
                <option key={z} value={z}>
                  {z}
                </option>
              ))}
            </Select>
          )}
        </Field>
        <Field label="Week starts on" error={errors.weekStartsOn}>
          {(p) => (
            <Select {...p} value={v.weekStartsOn} onChange={(e) => upd({ weekStartsOn: Number(e.target.value) })}>
              {WEEKDAYS.map((d, i) => (
                <option key={d} value={i}>
                  {d}
                </option>
              ))}
            </Select>
          )}
        </Field>
        <Field label="Default duration (minutes)" error={errors.defaultDurationMinutes}>
          {(p) => <Input {...p} type="number" min={15} step={15} value={v.defaultDurationMinutes} onChange={(e) => upd({ defaultDurationMinutes: Number(e.target.value) })} />}
        </Field>
        <Field label="Calendar day starts (hour)" error={errors.dayStartHour}>
          {(p) => <Input {...p} type="number" min={0} max={23} value={v.dayStartHour} onChange={(e) => upd({ dayStartHour: Number(e.target.value) })} />}
        </Field>
        <Field label="Calendar day ends (hour)" error={errors.dayEndHour}>
          {(p) => <Input {...p} type="number" min={1} max={24} value={v.dayEndHour} onChange={(e) => upd({ dayEndHour: Number(e.target.value) })} />}
        </Field>
        <Field label="Travel buffer between jobs (minutes)" error={errors.travelBufferMinutes} hint="0 = back-to-back bookings allowed. Applies to new bookings and edits.">
          {(p) => <Input {...p} type="number" min={0} max={240} step={5} value={v.travelBufferMinutes} onChange={(e) => upd({ travelBufferMinutes: Number(e.target.value) })} />}
        </Field>
      </div>
      <fieldset>
        <legend className="mb-2 text-sm font-medium text-fg">Closed days</legend>
        <p className="mb-2 text-xs text-fg-muted">No visits can be booked on these weekdays. Admins can still book one when needed.</p>
        <div className="flex flex-wrap gap-2">
          {WEEKDAYS.map((d, i) => {
            const on = v.closedWeekdays.includes(i);
            return (
              <label key={d} className={`inline-flex cursor-pointer items-center gap-2 rounded-lg border px-3 py-1.5 text-sm ${on ? "border-brand bg-brand-soft text-fg" : "border-line text-fg-muted"}`}>
                <input
                  type="checkbox"
                  className="h-4 w-4 accent-[var(--brand-strong)]"
                  checked={on}
                  onChange={(e) => upd({ closedWeekdays: e.target.checked ? [...v.closedWeekdays, i].sort() : v.closedWeekdays.filter((x) => x !== i) })}
                />
                {d}
              </label>
            );
          })}
        </div>
        {errors.closedWeekdays && <p className="mt-1 text-xs text-danger">{errors.closedWeekdays}</p>}
      </fieldset>
      <div className="grid gap-2 sm:grid-cols-3">
        <Checkbox label="Sales can view reports" checked={v.salesCanViewReports} onChange={(e) => upd({ salesCanViewReports: e.target.checked })} />
        <Checkbox
          label="Sales can edit any appointment"
          description="If off, Sales can only edit, reschedule and cancel bookings they created."
          checked={v.salesCanEditOthersAppointments}
          onChange={(e) => upd({ salesCanEditOthersAppointments: e.target.checked })}
        />
        <Checkbox
          label="Technicians see customer phone numbers"
          checked={v.technicianCanSeeContacts}
          onChange={(e) => upd({ technicianCanSeeContacts: e.target.checked })}
        />
      </div>
      <div className="flex justify-end">
        <Button type="submit" loading={saving}>
          Save settings
        </Button>
      </div>
    </form>
  );
}
