"use client";

import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { CheckCircle2, LogIn, LogOut, MapPin, MapPinOff } from "lucide-react";
import type { AttendanceSite } from "@prisma/client";
import { Button } from "@/components/ui/button";
import { Card, CardHeader } from "@/components/ui/card";
import { Field, Input, Select } from "@/components/ui/field";
import { Alert } from "@/components/ui/misc";
import { useT } from "@/i18n/client";
import { api, ApiError } from "@/lib/api-client";
import { currentPosition, type GeoReading } from "@/lib/geo-client";
import { timeKey } from "@/lib/time";
import { LiveCamera } from "./live-camera";

type Row = { id: string; at: string; site: AttendanceSite | null; distanceM: number | null; geofenceM: number | null; accuracyM: number | null; flags: { outside: boolean; noLocation: boolean; lowAccuracy: boolean }; selfieUrl: string | null };
export type ClockStateDTO = {
  day: string;
  companySet: boolean;
  clockIn: Row | null;
  clockOut: Row | null;
  visits: { id: string; code: string; customerName: string; area: string | null; startsAt: string; hasPin: boolean }[];
  workLocations: { id: string; name: string; nameAr: string | null; radiusM: number }[];
};

function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result));
    r.onerror = () => reject(r.error);
    r.readAsDataURL(blob);
  });
}

/** Clock in or out: where you are, a live photo and the phone's location; the time is the server's. */
export function ClockPanel({ state, tz }: { state: ClockStateDTO; tz: string }) {
  const t = useT();
  const router = useRouter();
  const action: "IN" | "OUT" | null = !state.clockIn ? "IN" : !state.clockOut ? "OUT" : null;
  const [site, setSite] = useState<AttendanceSite>((state.clockIn?.site as AttendanceSite | null) ?? "COMPANY");
  const [appointmentId, setAppointmentId] = useState(state.visits[0]?.id ?? "");
  const [workLocationId, setWorkLocationId] = useState(state.workLocations[0]?.id ?? "");
  const [note, setNote] = useState("");
  const [photo, setPhoto] = useState<Blob | null>(null);
  const photoUrl = useMemo(() => (photo ? URL.createObjectURL(photo) : null), [photo]);
  useEffect(() => () => void (photoUrl && URL.revokeObjectURL(photoUrl)), [photoUrl]);
  const [reading, setReading] = useState<GeoReading | null>(null);
  const [busy, setBusy] = useState(false);

  // Read the location as soon as the page opens, so the person sees its accuracy before sending.
  useEffect(() => {
    if (!action) return;
    let live = true;
    void currentPosition(20_000).then((r) => live && setReading(r));
    return () => {
      live = false;
    };
  }, [action]);

  async function submit() {
    if (!action || !photo) {
      toast.error(t("clock.errors.selfie"));
      return;
    }
    setBusy(true);
    try {
      // A fresh reading at the moment of sending (the earlier one only showed the accuracy).
      const fresh = await currentPosition(15_000);
      setReading(fresh);
      const { checkIn } = await api<{ checkIn: Row & { duplicate?: boolean } }>("/api/attendance/clock", {
        method: "POST",
        body: { action, site, appointmentId: site === "CUSTOMER" ? appointmentId : null, workLocationId: site === "WORK_LOCATION" ? workLocationId : null, geo: fresh.geo, selfie: await blobToDataUrl(photo), note },
      });
      if (checkIn.duplicate) toast.message(t("clock.already"));
      else if (checkIn.flags.noLocation) toast.warning(t(fresh.error === "denied" ? "clock.locationDenied" : "clock.locationUnavailable"));
      else if (checkIn.flags.outside) toast.warning(t("clock.outside", { metres: checkIn.distanceM ?? 0, radius: checkIn.geofenceM ?? 0 }));
      else if (checkIn.flags.lowAccuracy) toast.warning(t("clock.lowAccuracy", { metres: checkIn.accuracyM ?? 0 }));
      else toast.success(action === "IN" ? t("clock.recordedIn") : t("clock.recordedOut"));
      setPhoto(null);
      router.refresh();
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : t("errors.network"));
    } finally {
      setBusy(false);
    }
  }

  const time = (iso: string) => timeKey(new Date(iso), tz);
  return (
    <div className="space-y-6">
      <Card>
        <CardHeader title={t("clock.title")} description={t("clock.text")} />
        <div className="space-y-2 p-5 text-sm">
          {state.clockIn ? (
            <p className="flex items-center gap-2">
              <CheckCircle2 className="h-4 w-4 text-success" aria-hidden /> {t("clock.clockedIn", { time: time(state.clockIn.at) })} · {t(`clock.sites.${state.clockIn.site ?? "COMPANY"}`)}
            </p>
          ) : (
            <p className="text-fg-muted">{t("clock.notYet")}</p>
          )}
          {state.clockOut && (
            <p className="flex items-center gap-2">
              <CheckCircle2 className="h-4 w-4 text-success" aria-hidden /> {t("clock.clockedOut", { time: time(state.clockOut.at) })}
            </p>
          )}
          {!action && <Alert tone="success">{t("clock.done")}</Alert>}
        </div>
      </Card>

      {action && (
        <Card>
          <CardHeader title={action === "IN" ? t("clock.in") : t("clock.out")} />
          <div className="grid grid-cols-1 gap-5 p-5 md:grid-cols-2">
            <div className="space-y-4">
              <Field label={t("clock.where")}>
                {(p) => (
                  <Select {...p} value={site} onChange={(e) => setSite(e.target.value as AttendanceSite)}>
                    <option value="COMPANY">{t("clock.sites.COMPANY")}</option>
                    <option value="CUSTOMER" disabled={!state.visits.length}>
                      {t("clock.sites.CUSTOMER")}
                    </option>
                    <option value="WORK_LOCATION" disabled={!state.workLocations.length}>
                      {t("clock.sites.WORK_LOCATION")}
                    </option>
                  </Select>
                )}
              </Field>
              {site === "COMPANY" && !state.companySet && <p className="text-xs text-fg-subtle">{t("clock.noCompany")}</p>}
              {site === "CUSTOMER" && (
                <Field label={t("clock.visit")}>
                  {(p) => (
                    <Select {...p} value={appointmentId} onChange={(e) => setAppointmentId(e.target.value)}>
                      {state.visits.map((v) => (
                        <option key={v.id} value={v.id}>
                          {time(v.startsAt)} · {v.code} · {v.customerName}
                          {v.area ? ` · ${v.area}` : ""}
                        </option>
                      ))}
                    </Select>
                  )}
                </Field>
              )}
              {site === "WORK_LOCATION" && (
                <Field label={t("clock.workLocation")}>
                  {(p) => (
                    <Select {...p} value={workLocationId} onChange={(e) => setWorkLocationId(e.target.value)}>
                      {state.workLocations.map((w) => (
                        <option key={w.id} value={w.id}>
                          {t.locale === "ar" && w.nameAr ? w.nameAr : w.name}
                        </option>
                      ))}
                    </Select>
                  )}
                </Field>
              )}
              <Field label={t("clock.note")}>{(p) => <Input {...p} value={note} onChange={(e) => setNote(e.target.value)} maxLength={300} dir="auto" />}</Field>
              <p className="flex items-center gap-2 text-sm" role="status">
                {reading === null ? (
                  <>
                    <MapPin className="h-4 w-4 animate-pulse text-fg-subtle" aria-hidden /> {t("clock.locating")}
                  </>
                ) : reading.geo ? (
                  <>
                    <MapPin className="h-4 w-4 text-success" aria-hidden /> {t("clock.accuracy", { metres: Math.round(reading.geo.acc) })}
                  </>
                ) : (
                  <>
                    <MapPinOff className="h-4 w-4 text-warning" aria-hidden /> {t(reading.error === "denied" ? "clock.locationDenied" : "clock.locationUnavailable")}
                  </>
                )}
              </p>
            </div>
            <LiveCamera onPhoto={setPhoto} photoUrl={photoUrl} onRetake={() => setPhoto(null)} />
          </div>
          <div className="flex justify-end border-t border-line px-5 py-4">
            <Button size="lg" loading={busy} disabled={!photo || busy} onClick={() => void submit()}>
              {action === "IN" ? <LogIn className="h-4 w-4 rtl:-scale-x-100" /> : <LogOut className="h-4 w-4 rtl:-scale-x-100" />} {action === "IN" ? t("clock.in") : t("clock.out")}
            </Button>
          </div>
        </Card>
      )}
    </div>
  );
}
