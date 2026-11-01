"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { AlertTriangle, CheckCircle2, MapPin, MapPinOff, Navigation, Package, PhoneCall, Route } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardHeader } from "@/components/ui/card";
import { Dialog } from "@/components/ui/dialog";
import { Field, Select, Textarea } from "@/components/ui/field";
import { useT } from "@/i18n/client";
import type { MessageKey } from "@/i18n/translator";
import { api, ApiError } from "@/lib/api-client";
import { PROBLEM_REASONS } from "@/lib/field";
import { currentPosition } from "@/lib/geo-client";
import { timeKey } from "@/lib/time";
import { cn } from "@/lib/utils";
import type { CheckInDTO } from "@/lib/types";

type Stage = "PICKUP" | "READY" | "DEPART" | "ARRIVE";
const STAGES: { kind: Stage; label: MessageKey; icon: typeof MapPin }[] = [
  { kind: "PICKUP", label: "field.stage.PICKUP", icon: Package },
  { kind: "READY", label: "field.stage.READY", icon: PhoneCall },
  { kind: "DEPART", label: "field.stage.DEPART", icon: Navigation },
  { kind: "ARRIVE", label: "field.stage.ARRIVE", icon: MapPin },
];
/** While on the way, the position is sent this often (Aura api_ping) so the board's arrival time stays fresh. */
const PING_MS = 2 * 60_000;

/** The assigned technician's check-ins for a visit, with the phone's location. */
export function CheckInPanel({ appointmentId, checkIns, tz, active }: { appointmentId: string; checkIns: CheckInDTO[]; tz: string; active: boolean }) {
  const t = useT();
  const router = useRouter();
  const [busy, setBusy] = useState<string | null>(null);
  const [problemOpen, setProblemOpen] = useState(false);
  const [reason, setReason] = useState<string>("");
  const [note, setNote] = useState("");
  const [reasonError, setReasonError] = useState<string | undefined>();
  const done = (kind: string) => checkIns.find((c) => c.kind === kind);
  const onTheWay = !!done("DEPART") && !done("ARRIVE") && !done("DONE");

  useEffect(() => {
    if (!onTheWay) return;
    const send = async () => {
      const { geo } = await currentPosition(20_000);
      if (geo) await api("/api/check-ins/position", { method: "POST", body: geo }).catch(() => undefined);
    };
    const id = setInterval(send, PING_MS);
    return () => clearInterval(id);
  }, [onTheWay]);

  async function checkIn(kind: string, extra: { reason?: string; note?: string } = {}) {
    setBusy(kind);
    try {
      const { geo, error } = await currentPosition();
      const { checkIn } = await api<{ checkIn: CheckInDTO }>("/api/check-ins", { method: "POST", body: { kind, appointmentId, geo, ...extra } });
      if (error) toast.warning(t(error === "denied" ? "field.locationDenied" : "field.locationUnavailable"));
      else if (checkIn.far && checkIn.distanceM !== null) toast.warning(t("field.farFromCustomer", { metres: checkIn.distanceM }));
      else toast.success(checkIn.duplicate ? t("field.already") : t("field.recorded"));
      router.refresh();
      return true;
    } catch (e) {
      const err = e instanceof ApiError ? e : new ApiError(t("common.couldNotSave"), 0, "UNKNOWN");
      if (err.fieldErrors.reason) setReasonError(err.fieldErrors.reason);
      toast.error(err.message);
      return false;
    } finally {
      setBusy(null);
    }
  }

  const nextStage = STAGES.find((s) => s.kind !== "PICKUP" && !done(s.kind))?.kind;
  return (
    <Card>
      <CardHeader title={t("field.title")} description={t("field.text")} icon={<Route className="h-4 w-4" />} />
      <div className="space-y-4 p-5">
        <ol className="grid grid-cols-1 gap-2 sm:grid-cols-2">
          {STAGES.map(({ kind, label, icon: Icon }) => {
            const c = done(kind);
            return (
              <li key={kind}>
                {c ? (
                  <div className="flex items-start gap-2 rounded-lg border border-line bg-surface-muted px-3 py-2.5 text-sm">
                    <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-success" />
                    <span className="min-w-0">
                      <span className="block font-medium text-fg">{t(label)}</span>
                      <span className="block text-xs text-fg-muted">
                        <bdi>{timeKey(c.at, tz)}</bdi>
                        {c.etaAt && <> · {t("field.eta", { time: timeKey(c.etaAt, tz) })}</>}
                        {!c.hasLocation && <> · {t("field.noLocation")}</>}
                        {c.far && c.distanceM !== null && <span className="text-warning"> · {t("field.far", { metres: c.distanceM })}</span>}
                      </span>
                    </span>
                  </div>
                ) : (
                  <Button
                    variant={kind === nextStage ? "primary" : "outline"}
                    className="w-full justify-start"
                    disabled={!active || busy !== null}
                    loading={busy === kind}
                    onClick={() => checkIn(kind)}
                  >
                    <Icon className="h-4 w-4" /> {t(label)}
                  </Button>
                )}
              </li>
            );
          })}
        </ol>
        {checkIns
          .filter((c) => c.kind === "PROBLEM")
          .map((c) => (
            <p key={c.id} className="flex items-start gap-2 rounded-lg bg-danger-soft px-3 py-2 text-sm text-danger">
              <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
              <span>
                <bdi>{timeKey(c.at, tz)}</bdi> · {t.dyn(`field.reasons.${c.reason}`)}
                {c.note && (
                  <>
                    {" "}
                    · <span dir="auto">{c.note}</span>
                  </>
                )}
              </span>
            </p>
          ))}
        <div className="flex flex-wrap items-center gap-3">
          <Button variant="danger" size="sm" disabled={!active || busy !== null} onClick={() => setProblemOpen(true)}>
            <AlertTriangle className="h-4 w-4" /> {t("field.reportProblem")}
          </Button>
          <span className={cn("flex items-center gap-1 text-xs text-fg-subtle")}>
            <MapPinOff className="h-3.5 w-3.5" /> {t("field.locationHint")}
          </span>
        </div>
      </div>
      <Dialog
        open={problemOpen}
        onClose={() => setProblemOpen(false)}
        title={t("field.reportProblem")}
        description={t("field.problemText")}
        footer={
          <>
            <Button variant="ghost" onClick={() => setProblemOpen(false)} disabled={busy !== null}>
              {t("common.cancel")}
            </Button>
            <Button
              variant="danger"
              loading={busy === "PROBLEM"}
              onClick={async () => {
                if (!reason) {
                  setReasonError(t("field.errors.reason"));
                  return;
                }
                if (await checkIn("PROBLEM", { reason, note })) {
                  setProblemOpen(false);
                  setReason("");
                  setNote("");
                }
              }}
            >
              {t("field.sendProblem")}
            </Button>
          </>
        }
      >
        <div className="space-y-4">
          <Field label={t("field.reason")} required error={reasonError}>
            {(p) => (
              <Select
                {...p}
                value={reason}
                onChange={(e) => {
                  setReason(e.target.value);
                  setReasonError(undefined);
                }}
              >
                <option value="">{t("field.chooseReason")}</option>
                {PROBLEM_REASONS.map((r) => (
                  <option key={r} value={r}>
                    {t.dyn(`field.reasons.${r}`)}
                  </option>
                ))}
              </Select>
            )}
          </Field>
          <Field label={t("field.note")}>{(p) => <Textarea {...p} rows={3} maxLength={500} value={note} onChange={(e) => setNote(e.target.value)} />}</Field>
        </div>
      </Dialog>
    </Card>
  );
}
