"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input, Select } from "@/components/ui/field";
import { Badge } from "@/components/ui/misc";
import { useAction } from "@/components/erp/use-action";
import { useT } from "@/i18n/client";
import { api } from "@/lib/api-client";

type Day = { weekday: number; isOff: boolean; startTime: string | null; endTime: string | null };
type Mode = "hours" | "any" | "off";

const modeOf = (d: Day): Mode => (d.isOff ? "off" : d.startTime && d.endTime ? "hours" : "any");

/** One technician's week: per day a day off, set hours, or working without set hours. */
export function WorkHoursEditor({ technician, days, configured, updated, weekStartsOn }: { technician: { id: string; name: string }; days: Day[]; configured: boolean; updated: string | null; weekStartsOn: number }) {
  const t = useT();
  const { busy, errors, run } = useAction();
  const [rows, setRows] = useState(days.map((d) => ({ weekday: d.weekday, mode: modeOf(d), startTime: d.startTime ?? "09:00", endTime: d.endTime ?? "17:00" })));
  const [reason, setReason] = useState("");
  const order = Array.from({ length: 7 }, (_, i) => (weekStartsOn + i) % 7);
  const set = (weekday: number, patch: Partial<(typeof rows)[number]>) => setRows((rs) => rs.map((r) => (r.weekday === weekday ? { ...r, ...patch } : r)));
  async function save() {
    const body = {
      days: rows.map((r) => ({ weekday: r.weekday, isOff: r.mode === "off", startTime: r.mode === "hours" ? r.startTime : null, endTime: r.mode === "hours" ? r.endTime : null })),
      reason,
    };
    await run(() => api(`/api/work-hours/${technician.id}`, { method: "PUT", body }), () => t("workHours.saved", { name: technician.name }));
  }
  return (
    <Card className="p-4" data-hours={technician.name}>
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <h2 className="font-semibold text-fg">{technician.name}</h2>
        {configured ? updated && <span className="text-xs text-fg-muted">{updated}</span> : <Badge>{t("workHours.notSet")}</Badge>}
      </div>
      <fieldset>
        <legend className="sr-only">{t("workHours.weekOf", { name: technician.name })}</legend>
        <ul className="space-y-2">
          {order.map((weekday) => {
            const r = rows.find((x) => x.weekday === weekday)!;
            const day = t.dyn(`enums.weekday.${weekday}`);
            const i = rows.findIndex((x) => x.weekday === weekday);
            return (
              <li key={weekday} className="grid grid-cols-[6rem_minmax(0,1fr)] items-center gap-2 sm:grid-cols-[7rem_10rem_minmax(0,1fr)]">
                <span className="text-sm font-medium">{day}</span>
                <Select aria-label={t("workHours.dayMode", { day, name: technician.name })} value={r.mode} onChange={(e) => set(weekday, { mode: e.target.value as Mode })}>
                  <option value="hours">{t("workHours.modes.hours")}</option>
                  <option value="any">{t("workHours.modes.any")}</option>
                  <option value="off">{t("workHours.modes.off")}</option>
                </Select>
                {r.mode === "hours" && (
                  <div className="col-span-2 flex items-center gap-2 sm:col-span-1">
                    <Input type="time" aria-label={t("workHours.from", { day })} value={r.startTime} onChange={(e) => set(weekday, { startTime: e.target.value })} className="w-32" />
                    <span aria-hidden>–</span>
                    <Input type="time" aria-label={t("workHours.to", { day })} value={r.endTime} onChange={(e) => set(weekday, { endTime: e.target.value })} className="w-32" />
                  </div>
                )}
                {(errors[`days.${i}.endTime`] || errors[`days.${i}.startTime`]) && (
                  <p className="col-span-2 text-xs font-medium text-danger sm:col-span-3" role="alert">
                    {t.msg(errors[`days.${i}.endTime`] ?? errors[`days.${i}.startTime`])}
                  </p>
                )}
              </li>
            );
          })}
        </ul>
      </fieldset>
      <div className="mt-3 flex flex-col gap-2 sm:flex-row sm:items-end">
        <label className="flex-1 text-sm">
          <span className="mb-1 block text-fg-muted">{t("workHours.reason")}</span>
          <Input value={reason} onChange={(e) => setReason(e.target.value)} maxLength={500} dir="auto" />
        </label>
        <Button loading={busy} onClick={() => void save()} aria-label={t("workHours.saveFor", { name: technician.name })}>
          {t("common.save")}
        </Button>
      </div>
    </Card>
  );
}
