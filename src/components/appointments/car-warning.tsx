"use client";

import { useEffect, useState } from "react";
import { Alert } from "@/components/ui/misc";
import { useT } from "@/i18n/client";
import { api } from "@/lib/api-client";

/** What the company car already has in that period, while booking with the car (Aura api_carWarn). */
export function CarWarning({ date, time, latitude, longitude, area, excludeId }: { date: string; time: string; latitude: string; longitude: string; area: string; excludeId?: string }) {
  const t = useT();
  const [warning, setWarning] = useState<{ level?: string; message: string | null } | null>(null);
  useEffect(() => {
    if (!date || !time) return;
    const ctrl = new AbortController();
    const id = setTimeout(() => {
      const q = new URLSearchParams({ date, time, lat: latitude, lng: longitude, area, ...(excludeId ? { exclude: excludeId } : {}) });
      api<{ level?: string; message: string | null }>(`/api/route/warn?${q}`, { signal: ctrl.signal })
        .then(setWarning)
        .catch(() => undefined);
    }, 400);
    return () => {
      clearTimeout(id);
      ctrl.abort();
    };
  }, [date, time, latitude, longitude, area, excludeId]);
  if (!warning?.message) return null;
  return (
    <Alert tone={warning.level === "danger" ? "danger" : warning.level === "warning" ? "warning" : "info"} className="mt-2">
      {t.msg(warning.message)}
    </Alert>
  );
}
