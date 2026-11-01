import { Route } from "lucide-react";
import { Card, CardHeader } from "@/components/ui/card";
import { getT } from "@/i18n/server";
import { dateTime } from "@/lib/format";
import { timeKey } from "@/lib/time";
import type { CheckInDTO } from "@/lib/types";

/** Every technician's check-ins on a visit, for whoever manages it. */
export async function FieldLog({ checkIns, tz }: { checkIns: CheckInDTO[]; tz: string }) {
  const t = await getT();
  if (!checkIns.length) return null;
  return (
    <Card>
      <CardHeader title={t("field.log")} description={t("field.logText")} icon={<Route className="h-4 w-4" />} />
      <ol className="divide-y divide-line">
        {checkIns.map((c) => (
          <li key={c.id} className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5 px-5 py-2.5 text-sm">
            <span className="font-medium text-fg">{t.dyn(`field.stage.${c.kind}`)}</span>
            <span className="text-fg-muted">{c.user.name}</span>
            <bdi className="text-xs text-fg-subtle">{dateTime(c.at, tz, t.locale)}</bdi>
            {c.etaAt && <span className="text-xs text-fg-muted">{t("field.eta", { time: timeKey(c.etaAt, tz) })}</span>}
            {c.distanceM !== null && <span className={c.far ? "text-xs text-warning" : "text-xs text-fg-subtle"}>{t("field.distance", { metres: c.distanceM })}</span>}
            {!c.hasLocation && <span className="text-xs text-fg-subtle">{t("field.noLocation")}</span>}
            {c.reason && <span className="text-xs text-danger">{t.dyn(`field.reasons.${c.reason}`)}</span>}
            {c.note && (
              <span dir="auto" className="w-full text-start text-xs text-fg-muted">
                {c.note}
              </span>
            )}
          </li>
        ))}
      </ol>
    </Card>
  );
}
