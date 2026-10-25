"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { CheckCircle2, ClipboardCheck, PlayCircle, RotateCcw, XCircle } from "lucide-react";
import type { StatusKind } from "@prisma/client";
import { Button } from "@/components/ui/button";
import { Card, CardHeader } from "@/components/ui/card";
import { Field, Textarea } from "@/components/ui/field";
import { Alert } from "@/components/ui/misc";
import { api, ApiError } from "@/lib/api-client";
import { outcomeSchema, fieldErrorsFromZod, type VisitOutcome } from "@/lib/validation";
import { cn } from "@/lib/utils";

const CHOICES: { value: Exclude<VisitOutcome, "IN_PROGRESS">; label: string; icon: typeof CheckCircle2; tone: string }[] = [
  { value: "COMPLETED", label: "Done", icon: CheckCircle2, tone: "text-success" },
  { value: "NEEDS_REVISIT", label: "Needs another visit", icon: RotateCcw, tone: "text-warning" },
  { value: "UNABLE_TO_COMPLETE", label: "Unable to complete", icon: XCircle, tone: "text-danger" },
];

/** How the visit went, recorded by the assigned technician (or a manager) with a visit report. */
export function OutcomePanel({ id, version, statusKind, report }: { id: string; version: number; statusKind: StatusKind; report: string | null }) {
  const router = useRouter();
  const current = CHOICES.some((c) => c.value === statusKind) ? (statusKind as (typeof CHOICES)[number]["value"]) : null;
  const [outcome, setOutcome] = useState<(typeof CHOICES)[number]["value"] | null>(current);
  const [text, setText] = useState(report ?? "");
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<string | null>(null);

  async function send(body: { outcome: VisitOutcome; report?: string }) {
    const check = outcomeSchema.safeParse({ ...body, version });
    if (!check.success) {
      setErrors(fieldErrorsFromZod(check.error));
      return;
    }
    setBusy(body.outcome);
    setErrors({});
    try {
      await api(`/api/appointments/${id}/outcome`, { method: "POST", body: { ...body, version } });
      toast.success(body.outcome === "IN_PROGRESS" ? "Job started" : "Visit outcome saved");
      router.refresh();
    } catch (e) {
      const err = e instanceof ApiError ? e : new ApiError("Could not save", 0, "UNKNOWN");
      setErrors(err.fieldErrors);
      toast.error(err.message);
      if (err.code === "STALE_RECORD") router.refresh();
    } finally {
      setBusy(null);
    }
  }

  return (
    <Card className="border-brand/40">
      <CardHeader title="Visit outcome" description="Record how the visit went. The report is shown to Sales and kept in the history." icon={<ClipboardCheck className="h-4 w-4" />} />
      <div className="space-y-4 p-5">
        {statusKind === "SCHEDULED" && (
          <Button variant="outline" className="w-full sm:w-auto" loading={busy === "IN_PROGRESS"} onClick={() => send({ outcome: "IN_PROGRESS" })}>
            <PlayCircle className="h-4 w-4" /> Start job
          </Button>
        )}
        <div role="radiogroup" aria-label="Outcome" className="grid gap-2 sm:grid-cols-3">
          {CHOICES.map(({ value, label, icon: Icon, tone }) => (
            <button
              key={value}
              type="button"
              role="radio"
              aria-checked={outcome === value}
              onClick={() => setOutcome(value)}
              className={cn(
                "flex items-center gap-2 rounded-lg border px-3 py-3 text-left text-sm font-medium transition-colors",
                outcome === value ? "border-brand bg-brand-soft text-fg" : "border-line text-fg-muted hover:bg-surface-muted",
              )}
            >
              <Icon className={cn("h-5 w-5 shrink-0", tone)} /> {label}
            </button>
          ))}
        </div>
        {errors.outcome && <Alert tone="danger">{errors.outcome}</Alert>}
        <Field label="Visit report" required error={errors.report} hint="What was installed or done, what is missing, anything the next visit needs to know.">
          {(p) => <Textarea {...p} rows={4} value={text} onChange={(e) => setText(e.target.value)} />}
        </Field>
        <Button className="w-full sm:w-auto" disabled={!outcome} loading={busy !== null && busy !== "IN_PROGRESS"} onClick={() => outcome && send({ outcome, report: text })}>
          Save outcome
        </Button>
      </div>
    </Card>
  );
}
