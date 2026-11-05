"use client";

import { useState } from "react";
import { Crosshair, Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardHeader } from "@/components/ui/card";
import { Dialog } from "@/components/ui/dialog";
import { Checkbox, Field, Input } from "@/components/ui/field";
import { Badge } from "@/components/ui/misc";
import { useAction } from "@/components/erp/use-action";
import { useT } from "@/i18n/client";
import { api } from "@/lib/api-client";
import { currentPosition } from "@/lib/geo-client";

type Loc = { id: string; name: string; nameAr: string | null; latitude: number; longitude: number; radiusM: number; isActive: boolean };

/** Approved work locations (geofences other than the company), for attendance managers. */
export function WorkLocations({ rows }: { rows: Loc[] }) {
  const t = useT();
  const [editing, setEditing] = useState<Loc | "new" | null>(null);
  return (
    <Card>
      <CardHeader
        title={t("clock.locations")}
        description={t("clock.locationsText")}
        actions={
          <Button size="sm" variant="outline" onClick={() => setEditing("new")}>
            <Plus className="h-4 w-4" /> {t("clock.addLocation")}
          </Button>
        }
      />
      {rows.length === 0 ? (
        <p className="px-5 pb-5 text-sm text-fg-muted">{t("clock.noWorkLocations")}</p>
      ) : (
        <ul className="divide-y divide-line">
          {rows.map((w) => (
            <li key={w.id} className="flex flex-wrap items-center gap-3 px-5 py-3 text-sm">
              <span className="font-medium" dir="auto">
                {t.locale === "ar" && w.nameAr ? w.nameAr : w.name}
              </span>
              {!w.isActive && <Badge>{t("common.inactive")}</Badge>}
              <span className="text-xs text-fg-muted" dir="ltr">
                {`${w.latitude.toFixed(5)}, ${w.longitude.toFixed(5)} · ${w.radiusM} m`}
              </span>
              <Button size="sm" variant="ghost" className="ms-auto" onClick={() => setEditing(w)}>
                {t("common.edit")}
              </Button>
            </li>
          ))}
        </ul>
      )}
      {editing && <LocationDialog initial={editing === "new" ? null : editing} onClose={() => setEditing(null)} />}
    </Card>
  );
}

function LocationDialog({ initial, onClose }: { initial: Loc | null; onClose: () => void }) {
  const t = useT();
  const { busy, errors, run } = useAction();
  const [v, setV] = useState({ name: initial?.name ?? "", nameAr: initial?.nameAr ?? "", latitude: initial ? String(initial.latitude) : "", longitude: initial ? String(initial.longitude) : "", radiusM: String(initial?.radiusM ?? 200), isActive: initial?.isActive ?? true });
  async function save() {
    const r = await run(() => (initial ? api(`/api/attendance/work-locations/${initial.id}`, { method: "PATCH", body: v }) : api("/api/attendance/work-locations", { method: "POST", body: v })), () => t("catalog.savedEntry"));
    if (r) onClose();
  }
  return (
    <Dialog
      open
      onClose={onClose}
      title={initial ? t("common.edit") : t("clock.addLocation")}
      footer={
        <>
          <Button variant="outline" onClick={onClose}>
            {t("common.cancel")}
          </Button>
          <Button loading={busy} onClick={() => void save()}>
            {t("common.save")}
          </Button>
        </>
      }
    >
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <Field label={t("clock.locationName")} required error={errors.name}>
          {(p) => <Input {...p} value={v.name} onChange={(e) => setV({ ...v, name: e.target.value })} dir="auto" />}
        </Field>
        <Field label={t("catalog.nameAr")} error={errors.nameAr}>
          {(p) => <Input {...p} value={v.nameAr} onChange={(e) => setV({ ...v, nameAr: e.target.value })} dir="rtl" />}
        </Field>
        <Field label={t("historyFields.location.latitude")} required error={errors.latitude}>
          {(p) => <Input {...p} value={v.latitude} onChange={(e) => setV({ ...v, latitude: e.target.value })} inputMode="decimal" dir="ltr" />}
        </Field>
        <Field label={t("historyFields.location.longitude")} required error={errors.longitude}>
          {(p) => <Input {...p} value={v.longitude} onChange={(e) => setV({ ...v, longitude: e.target.value })} inputMode="decimal" dir="ltr" />}
        </Field>
        <Field label={t("clock.radius")} required error={errors.radiusM}>
          {(p) => <Input {...p} value={v.radiusM} onChange={(e) => setV({ ...v, radiusM: e.target.value })} inputMode="numeric" dir="ltr" />}
        </Field>
        <div className="flex items-end">
          <Button
            type="button"
            variant="ghost"
            onClick={async () => {
              const r = await currentPosition();
              if (r.geo) setV((x) => ({ ...x, latitude: r.geo!.lat.toFixed(6), longitude: r.geo!.lng.toFixed(6) }));
            }}
          >
            <Crosshair className="h-4 w-4" /> {t("clock.useMyLocation")}
          </Button>
        </div>
        <Checkbox label={t("common.active")} checked={v.isActive} onChange={(e) => setV({ ...v, isActive: e.target.checked })} />
      </div>
    </Dialog>
  );
}
