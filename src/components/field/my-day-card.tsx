"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Building2, Camera, LogOut, Trophy } from "lucide-react";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { Card, CardHeader } from "@/components/ui/card";
import { useT } from "@/i18n/client";
import { api, ApiError } from "@/lib/api-client";
import { currentPosition } from "@/lib/geo-client";
import { timeKey } from "@/lib/time";
import type { CheckInDTO } from "@/lib/types";

/** The technician's arrival at the company and departure for the day (Aura حضور / انصراف), and this month's points. */
export function MyDayCard({ company, leave, tz, points, selfieRequired = false }: { company: CheckInDTO | null; leave: CheckInDTO | null; tz: string; points: number | null; selfieRequired?: boolean }) {
  const t = useT();
  const router = useRouter();
  const [busy, setBusy] = useState<string | null>(null);

  async function checkIn(kind: "COMPANY" | "LEAVE") {
    setBusy(kind);
    try {
      const { geo, error } = await currentPosition();
      const { checkIn } = await api<{ checkIn: CheckInDTO }>("/api/check-ins", { method: "POST", body: { kind, geo } });
      if (error) toast.warning(t(error === "denied" ? "field.locationDenied" : "field.locationUnavailable"));
      else if (checkIn.far && checkIn.distanceM !== null) toast.warning(t("field.farFromCompany", { metres: checkIn.distanceM }));
      else toast.success(checkIn.duplicate ? t("field.already") : t("field.recorded"));
      router.refresh();
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : t("common.couldNotSave"));
    } finally {
      setBusy(null);
    }
  }

  const line = (c: CheckInDTO) => (
    <span className="text-sm text-fg-muted">
      <bdi>{timeKey(c.at, tz)}</bdi>
      {c.lateMinutes && <span className="text-warning"> · {t("field.late", { minutes: c.lateMinutes })}</span>}
      {c.earlyMinutes && <span className="text-warning"> · {t("field.early", { minutes: c.earlyMinutes })}</span>}
      {c.far && c.distanceM !== null && <span className="text-warning"> · {t("field.far", { metres: c.distanceM })}</span>}
      {!c.hasLocation && <> · {t("field.noLocation")}</>}
    </span>
  );

  return (
    <Card>
      <CardHeader
        title={t("field.myDay")}
        description={t("field.myDayText")}
        icon={<Building2 className="h-4 w-4" />}
        actions={
          points !== null ? (
            <Link href="/attendance" className="inline-flex items-center gap-1.5 rounded-full bg-brand-soft px-3 py-1 text-sm font-medium text-brand-text">
              <Trophy className="h-4 w-4" /> {t("field.pointsShort", { points })}
            </Link>
          ) : undefined
        }
      />
      <div className="px-5 pt-4">
        <Link href="/attendance/clock" className="inline-flex items-center gap-1.5 text-sm font-medium text-brand-text hover:underline">
          <Camera className="h-4 w-4" /> {t("clock.title")}
        </Link>
      </div>
      <div className="grid grid-cols-1 gap-3 p-5 sm:grid-cols-2">
        <div className="space-y-1">
          <p className="text-sm font-medium text-fg">{t("field.stage.COMPANY")}</p>
          {company ? (
            line(company)
          ) : selfieRequired ? (
            <Link href="/attendance/clock" className="flex h-10 w-full items-center justify-center gap-2 rounded-lg bg-brand-strong text-sm font-semibold text-white hover:bg-brand-stronger">
              <Camera className="h-4 w-4" /> {t("clock.in")}
            </Link>
          ) : (
            <Button className="w-full" loading={busy === "COMPANY"} disabled={busy !== null} onClick={() => checkIn("COMPANY")}>
              <Building2 className="h-4 w-4" /> {t("field.arriveCompany")}
            </Button>
          )}
        </div>
        <div className="space-y-1">
          <p className="text-sm font-medium text-fg">{t("field.stage.LEAVE")}</p>
          {leave ? (
            line(leave)
          ) : selfieRequired ? (
            <Link href="/attendance/clock" className="flex h-10 w-full items-center justify-center gap-2 rounded-lg border border-line-strong text-sm font-semibold hover:bg-surface-muted">
              <Camera className="h-4 w-4" /> {t("clock.out")}
            </Link>
          ) : (
            <Button variant="outline" className="w-full" loading={busy === "LEAVE"} disabled={!company || busy !== null} onClick={() => checkIn("LEAVE")}>
              <LogOut className="h-4 w-4 rtl:rotate-180" /> {t("field.leaveDay")}
            </Button>
          )}
        </div>
      </div>
    </Card>
  );
}
