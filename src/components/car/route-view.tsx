"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { ArrowDown, ArrowUp, Building2, CheckCircle2, MapPin, Navigation, Phone, Undo2, UserCheck, Users } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Alert, EmptyState } from "@/components/ui/misc";
import { useT } from "@/i18n/client";
import { api, ApiError } from "@/lib/api-client";
import { currentPosition } from "@/lib/geo-client";
import { timeKey } from "@/lib/time";
import type { CheckInDTO } from "@/lib/types";
import { cn } from "@/lib/utils";
import type { RouteView as Route } from "@/server/services/car";

const PING_MS = 2 * 60_000;

/** The company car's stops for a day: the driver checks in at each, the head of installations orders them. */
export function RouteView({ route, tz }: { route: Route; tz: string }) {
  const t = useT();
  const router = useRouter();
  const [busy, setBusy] = useState<string | null>(null);
  const [order, setOrder] = useState<string[] | null>(null);
  const stops = order ? order.map((id) => route.stops.find((s) => s.id === id)!) : route.stops;
  const driving = route.canCheckIn && !!route.go && !route.back;

  // While the car is out, its position keeps the live board's arrival time fresh (Aura api_ping).
  useEffect(() => {
    if (!driving) return;
    const id = setInterval(async () => {
      const { geo } = await currentPosition(20_000);
      if (geo) await api("/api/check-ins/position", { method: "POST", body: geo }).catch(() => undefined);
    }, PING_MS);
    return () => clearInterval(id);
  }, [driving]);

  async function checkIn(kind: string, appointmentId?: string) {
    setBusy(`${kind}:${appointmentId ?? ""}`);
    try {
      const { geo, error } = await currentPosition();
      const { checkIn } = await api<{ checkIn: CheckInDTO }>("/api/route/check-ins", { method: "POST", body: { kind, appointmentId, geo } });
      if (error) toast.warning(t(error === "denied" ? "field.locationDenied" : "field.locationUnavailable"));
      else if (checkIn.far && checkIn.distanceM !== null) toast.warning(t("field.farFromCustomer", { metres: checkIn.distanceM }));
      else toast.success(checkIn.duplicate ? t("field.already") : t("field.recorded"));
      router.refresh();
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : t("common.couldNotSave"));
    } finally {
      setBusy(null);
    }
  }

  function move(i: number, d: -1 | 1) {
    const ids = stops.map((s) => s.id);
    const j = i + d;
    if (j < 0 || j >= ids.length) return;
    [ids[i], ids[j]] = [ids[j]!, ids[i]!];
    setOrder(ids);
  }

  async function saveOrder() {
    if (!order) return;
    setBusy("order");
    try {
      await api("/api/route/order", { method: "PUT", body: { day: route.day, ids: order } });
      toast.success(t("car.orderSaved"));
      setOrder(null);
      router.refresh();
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : t("common.couldNotSave"));
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="space-y-4">
      {route.canCheckIn && (
        <Card className="flex flex-wrap items-center gap-3 p-4">
          {route.go ? (
            <span className="flex items-center gap-2 text-sm text-fg">
              <CheckCircle2 className="h-4 w-4 text-success" /> {t("car.leftAt", { time: timeKey(route.go, tz) })}
            </span>
          ) : (
            <Button loading={busy === "CAR_GO:"} disabled={busy !== null} onClick={() => checkIn("CAR_GO")}>
              <Navigation className="h-4 w-4" /> {t("car.stage.CAR_GO")}
            </Button>
          )}
          {route.back ? (
            <span className="flex items-center gap-2 text-sm text-fg">
              <CheckCircle2 className="h-4 w-4 text-success" /> {t("car.backAt", { time: timeKey(route.back, tz) })}
            </span>
          ) : (
            <Button variant="outline" loading={busy === "CAR_BACK:"} disabled={!route.go || busy !== null} onClick={() => checkIn("CAR_BACK")}>
              <Building2 className="h-4 w-4" /> {t("car.stage.CAR_BACK")}
            </Button>
          )}
        </Card>
      )}

      {route.warnings.map((w, i) => (
        <Alert key={i} tone="warning">
          {t.msg(w.message)}
        </Alert>
      ))}

      {route.canReorder && order && (
        <div className="flex flex-wrap items-center gap-2">
          <Button loading={busy === "order"} onClick={saveOrder}>
            {t("car.saveOrder")}
          </Button>
          <Button variant="ghost" onClick={() => setOrder(null)} disabled={busy !== null}>
            <Undo2 className="h-4 w-4" /> {t("common.cancel")}
          </Button>
        </div>
      )}

      <Card>
        {stops.length === 0 ? (
          <EmptyState title={t("car.noStops")} icon={<MapPin className="h-6 w-6" />} />
        ) : (
          <ol className="divide-y divide-line">
            {stops.map((s, i) => (
              <li key={s.id} className="flex gap-3 px-4 py-4">
                <span className={cn("flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-sm font-semibold", s.manual ? "bg-brand-strong text-white" : "bg-brand-soft text-brand-text")}>{i + 1}</span>
                <div className="min-w-0 flex-1 space-y-1.5">
                  <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                    <Link href={`/appointments/${s.id}`} className="font-medium text-fg hover:underline">
                      {s.customerName}
                    </Link>
                    <bdi className="text-sm tabular-nums text-fg-muted">{timeKey(s.startsAt, tz)}</bdi>
                    <span className="rounded-full bg-surface-muted px-2 py-0.5 text-xs text-fg-muted">{t.dyn(`car.slot.${s.slot}`)}</span>
                    {s.finished && <span className="rounded-full bg-success-soft px-2 py-0.5 text-xs text-success">{t("car.teamDone")}</span>}
                  </div>
                  {(s.area || s.address) && <p className="text-sm text-fg-muted">{[s.area, s.address].filter(Boolean).join(" · ")}</p>}
                  <p className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-fg-muted">
                    <span className="inline-flex items-center gap-1">
                      <Users className="h-3.5 w-3.5" /> {s.technicians.map((x) => x.name).join("، ") || t("appointments.noTechnician")}
                    </span>
                    {s.teamStage && (
                      <span>
                        {t.dyn(`field.stageShort.${s.teamStage.kind}`)} <bdi>{timeKey(s.teamStage.at, tz)}</bdi>
                      </span>
                    )}
                    {s.drop && <span>{t("car.droppedAt", { time: timeKey(s.drop, tz) })}</span>}
                    {s.pick && <span>{t("car.pickedAt", { time: timeKey(s.pick, tz) })}</span>}
                  </p>
                  <div className="flex flex-wrap items-center gap-2 pt-1">
                    {s.mapLink && (
                      <a href={s.mapLink} target="_blank" rel="noopener noreferrer" className="inline-flex h-8 items-center gap-1.5 rounded-lg border border-line px-2.5 text-xs font-medium text-fg hover:bg-surface-muted">
                        <MapPin className="h-3.5 w-3.5" /> {t("appointment.openLocation")}
                      </a>
                    )}
                    {s.customerPhone && (
                      <a href={`tel:${s.customerPhone.replace(/[^\d+]/g, "")}`} className="inline-flex h-8 items-center gap-1.5 rounded-lg border border-line px-2.5 text-xs font-medium text-fg hover:bg-surface-muted">
                        <Phone className="h-3.5 w-3.5" /> {t("appointment.callCustomer")}
                      </a>
                    )}
                    {route.canCheckIn && !s.drop && (
                      <Button size="sm" disabled={!route.go || busy !== null} loading={busy === `CAR_DROP:${s.id}`} onClick={() => checkIn("CAR_DROP", s.id)}>
                        <UserCheck className="h-4 w-4" /> {t("car.stage.CAR_DROP")}
                      </Button>
                    )}
                    {route.canCheckIn && s.drop && !s.pick && (
                      <Button size="sm" variant={s.readyForPick ? "primary" : "outline"} disabled={busy !== null} loading={busy === `CAR_PICK:${s.id}`} onClick={() => checkIn("CAR_PICK", s.id)}>
                        <Users className="h-4 w-4" /> {t("car.stage.CAR_PICK")}
                      </Button>
                    )}
                  </div>
                </div>
                {route.canReorder && stops.length > 1 && (
                  <div className="flex flex-col gap-1">
                    <Button size="icon" variant="ghost" aria-label={t("car.moveUp")} disabled={i === 0 || busy !== null} onClick={() => move(i, -1)}>
                      <ArrowUp className="h-4 w-4" />
                    </Button>
                    <Button size="icon" variant="ghost" aria-label={t("car.moveDown")} disabled={i === stops.length - 1 || busy !== null} onClick={() => move(i, 1)}>
                      <ArrowDown className="h-4 w-4" />
                    </Button>
                  </div>
                )}
              </li>
            ))}
          </ol>
        )}
      </Card>
      {!route.drivers.length && <p className="text-sm text-fg-subtle">{t("car.noDriver")}</p>}
    </div>
  );
}
