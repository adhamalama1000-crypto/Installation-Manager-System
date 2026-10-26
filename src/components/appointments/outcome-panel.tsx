"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { CheckCircle2, ClipboardCheck, PlayCircle, RotateCcw, XCircle } from "lucide-react";
import type { PaymentMethod, StatusKind } from "@prisma/client";
import { Button } from "@/components/ui/button";
import { Card, CardHeader } from "@/components/ui/card";
import { Field, Input, Select, Textarea } from "@/components/ui/field";
import { Alert } from "@/components/ui/misc";
import { useT } from "@/i18n/client";
import type { MessageKey } from "@/i18n/translator";
import { api, ApiError } from "@/lib/api-client";
import { PAYMENT_METHODS, money, parseSerials } from "@/lib/constants";
import type { PaymentDTO } from "@/lib/types";
import { outcomeSchema, fieldErrorsFromZod, type VisitOutcome } from "@/lib/validation";
import { cn } from "@/lib/utils";

const CHOICES: { value: Exclude<VisitOutcome, "IN_PROGRESS">; label: MessageKey; icon: typeof CheckCircle2; tone: string }[] = [
  { value: "COMPLETED", label: "outcome.done", icon: CheckCircle2, tone: "text-success" },
  { value: "NEEDS_REVISIT", label: "outcome.revisit", icon: RotateCcw, tone: "text-warning" },
  { value: "UNABLE_TO_COMPLETE", label: "outcome.unable", icon: XCircle, tone: "text-danger" },
];

/** How the visit went, recorded by the assigned technician (or a manager) with a visit report. */
export function OutcomePanel({
  id,
  version,
  statusKind,
  report,
  payment,
  myStock,
}: {
  id: string;
  version: number;
  statusKind: StatusKind;
  report: string | null;
  payment: PaymentDTO | null;
  /** Items the technician holds, offered as quick picks. */
  myStock: { serial: string; model: string }[];
}) {
  const t = useT();
  const router = useRouter();
  const current = CHOICES.some((c) => c.value === statusKind) ? (statusKind as (typeof CHOICES)[number]["value"]) : null;
  const [outcome, setOutcome] = useState<(typeof CHOICES)[number]["value"] | null>(current);
  const [text, setText] = useState(report ?? "");
  const recorded = payment?.collectedAmount ?? null;
  const [collected, setCollected] = useState(recorded === null ? "" : String(recorded));
  const [method, setMethod] = useState<PaymentMethod>(payment?.collectedMethod ?? "CASH");
  const [serials, setSerials] = useState("");
  const typed = parseSerials(serials);
  const addSerial = (s: string) => setSerials((v) => (parseSerials(v).includes(s) ? v : `${v.trim() ? `${v.trim()}\n` : ""}${s}`));
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<string | null>(null);

  async function send(body: { outcome: VisitOutcome; report?: string; collectedAmount?: string | null; collectedMethod?: PaymentMethod | null; serials?: string }) {
    const check = outcomeSchema.safeParse({ ...body, version });
    if (!check.success) {
      setErrors(fieldErrorsFromZod(check.error));
      return;
    }
    setBusy(body.outcome);
    setErrors({});
    try {
      await api(`/api/appointments/${id}/outcome`, { method: "POST", body: { ...body, version } });
      toast.success(body.outcome === "IN_PROGRESS" ? t("outcome.started") : t("outcome.saved"));
      if (body.serials) setSerials("");
      router.refresh();
    } catch (e) {
      const err = e instanceof ApiError ? e : new ApiError(t("common.couldNotSave"), 0, "UNKNOWN");
      setErrors(err.fieldErrors);
      toast.error(err.message);
      if (err.code === "STALE_RECORD") router.refresh();
    } finally {
      setBusy(null);
    }
  }

  return (
    <Card className="border-brand/40">
      <CardHeader title={t("outcome.title")} description={t("outcome.text")} icon={<ClipboardCheck className="h-4 w-4" />} />
      <div className="space-y-4 p-5">
        {statusKind === "SCHEDULED" && (
          <Button variant="outline" className="w-full sm:w-auto" loading={busy === "IN_PROGRESS"} onClick={() => send({ outcome: "IN_PROGRESS" })}>
            <PlayCircle className="h-4 w-4" /> {t("outcome.start")}
          </Button>
        )}
        <div role="radiogroup" aria-label={t("outcome.label")} className="grid gap-2 sm:grid-cols-3">
          {CHOICES.map(({ value, label, icon: Icon, tone }) => (
            <button
              key={value}
              type="button"
              role="radio"
              aria-checked={outcome === value}
              onClick={() => setOutcome(value)}
              className={cn(
                "flex items-center gap-2 rounded-lg border px-3 py-3 text-start text-sm font-medium transition-colors",
                outcome === value ? "border-brand bg-brand-soft text-fg" : "border-line text-fg-muted hover:bg-surface-muted",
              )}
            >
              <Icon className={cn("h-5 w-5 shrink-0", tone)} /> {t(label)}
            </button>
          ))}
        </div>
        {errors.outcome && <Alert tone="danger">{t.msg(errors.outcome)}</Alert>}
        <Field label={t("appointment.visitReport")} required error={errors.report} hint={t("outcome.reportHint")}>
          {(p) => <Textarea {...p} rows={4} value={text} onChange={(e) => setText(e.target.value)} />}
        </Field>
        {outcome === "COMPLETED" && (
          <div className="space-y-2">
            <Field label={t("outcome.serials")} error={errors.serials} hint={t("outcome.serialsHint")}>
              {(p) => <Textarea {...p} rows={2} dir="ltr" className="font-mono" value={serials} onChange={(e) => setSerials(e.target.value)} />}
            </Field>
            {myStock.length > 0 && (
              <div className="flex flex-wrap gap-1.5" aria-label={t("outcome.yourItems")}>
                {myStock.map((i) => (
                  <button
                    key={i.serial}
                    type="button"
                    onClick={() => addSerial(i.serial)}
                    disabled={typed.includes(i.serial)}
                    className="rounded-full border border-line px-2.5 py-1 font-mono text-xs text-fg-muted hover:bg-surface-muted disabled:opacity-50"
                    title={i.model}
                  >
                    + {i.serial}
                  </button>
                ))}
              </div>
            )}
          </div>
        )}
        {payment && (
          <div className="grid gap-3 sm:grid-cols-2">
            <Field
              label={t("outcome.collected")}
              error={errors.collectedAmount}
              hint={payment.due !== null ? t("outcome.toCollectHint", { amount: money(payment.due, t.locale) }) : t("outcome.noPaymentHint")}
            >
              {(p) => <Input {...p} inputMode="decimal" value={collected} onChange={(e) => setCollected(e.target.value)} />}
            </Field>
            <Field label={t("outcome.paidBy")} error={errors.collectedMethod}>
              {(p) => (
                <Select {...p} value={method} disabled={!Number(collected.replace(/[,\s]/g, ""))} onChange={(e) => setMethod(e.target.value as PaymentMethod)}>
                  {PAYMENT_METHODS.map((m) => (
                    <option key={m} value={m}>
                      {t.dyn(`enums.paymentMethod.${m}`)}
                    </option>
                  ))}
                </Select>
              )}
            </Field>
          </div>
        )}
        <Button
          className="w-full sm:w-auto"
          disabled={!outcome}
          loading={busy !== null && busy !== "IN_PROGRESS"}
          onClick={() => {
            if (!outcome) return;
            // Left empty and never recorded: leave the payment untouched.
            const untouched = collected.trim() === "" && recorded === null;
            send({
              outcome,
              report: text,
              ...(outcome === "COMPLETED" && typed.length ? { serials } : {}),
              ...(payment && !untouched ? { collectedAmount: collected, collectedMethod: Number(collected.replace(/[,\s]/g, "")) ? method : null } : {}),
            });
          }}
        >
          {t("outcome.save")}
        </Button>
      </div>
    </Card>
  );
}
