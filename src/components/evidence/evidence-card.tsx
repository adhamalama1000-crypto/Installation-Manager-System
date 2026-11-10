"use client";

import { useState } from "react";
import {
  BadgeCheck,
  CheckCircle2,
  Circle,
  CircleAlert,
  RotateCcw,
  ShieldCheck,
  Undo2,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardHeader } from "@/components/ui/card";
import { Dialog } from "@/components/ui/dialog";
import { Checkbox, Field, Input, Textarea } from "@/components/ui/field";
import { Alert, Badge } from "@/components/ui/misc";
import { useAction } from "@/components/erp/use-action";
import { useT } from "@/i18n/client";
import { api } from "@/lib/api-client";
import type { EvidenceStatusDTO, WorkReviewEventValue } from "@/lib/evidence";
import { dateTime } from "@/lib/format";
import { cn } from "@/lib/utils";

const TONE: Record<WorkReviewEventValue | "NONE", string> = {
  NONE: "",
  SUBMITTED: "border-warning/40 bg-warning-soft text-fg",
  APPROVED: "border-success/40 bg-success-soft text-success",
  REJECTED: "border-danger/40 bg-danger-soft text-danger",
};

/**
 * The visit's work evidence: what its rule asks for and what is there, the review status and its
 * history; reviewers approve or send the work back with the reason, and the technician submits it
 * again once corrected. The server enforces every one of these rules.
 */
export function EvidenceCard({
  id,
  evidence,
  tz,
}: {
  id: string;
  evidence: EvidenceStatusDTO;
  tz: string;
}) {
  const t = useT();
  const [dialog, setDialog] = useState<
    "APPROVED" | "REJECTED" | "RESUBMIT" | null
  >(null);
  const [note, setNote] = useState("");
  const [confirmed, setConfirmed] = useState(false);
  const [customerName, setCustomerName] = useState("");
  const { busy, errors, run } = useAction();
  const { rule, state, missing, status, history, can } = evidence;
  // No rule and no review: nothing to show. A visit reviewed under a rule that was later switched
  // off keeps its status and history.
  if (!rule && !history.length) return null;

  const items: { label: string; done: boolean }[] = !rule
    ? []
    : [
        ...(rule.minBeforePhotos
          ? [
              {
                label: t("evidence.req.before", {
                  have: state.beforePhotos,
                  need: rule.minBeforePhotos,
                }),
                done: state.beforePhotos >= rule.minBeforePhotos,
              },
            ]
          : []),
        ...(rule.minAfterPhotos
          ? [
              {
                label: t("evidence.req.after", {
                  have: state.afterPhotos,
                  need: rule.minAfterPhotos,
                }),
                done: state.afterPhotos >= rule.minAfterPhotos,
              },
            ]
          : []),
        ...(rule.requireVideo
          ? [{ label: t("evidence.req.video"), done: state.videos > 0 }]
          : []),
        ...(rule.requireSignature
          ? [{ label: t("evidence.req.signature"), done: state.hasSignature }]
          : []),
        ...(rule.requireCustomerConfirmation
          ? [
              {
                label: t("evidence.req.confirmation"),
                done: state.customerConfirmed,
              },
            ]
          : []),
      ];
  // Customer confirmation is given when the work is submitted, so it is not "missing" on screen
  // until then; the photos, video and signature are.
  const shownMissing = missing.filter(
    (m) => m.key !== "evidence.missing.confirmation" || status !== null,
  );

  function open(d: typeof dialog) {
    setNote("");
    setConfirmed(false);
    setCustomerName("");
    setDialog(d);
  }

  async function decide(decision: "APPROVED" | "REJECTED") {
    const r = await run(
      () =>
        api(`/api/appointments/${id}/evidence/decision`, {
          method: "POST",
          body: { decision, note },
        }),
      () =>
        t(decision === "APPROVED" ? "evidence.approved" : "evidence.rejected"),
    );
    if (r) setDialog(null);
  }

  async function resubmit() {
    const r = await run(
      () =>
        api(`/api/appointments/${id}/evidence/resubmit`, {
          method: "POST",
          body: { customerConfirmed: confirmed, customerName, note },
        }),
      () => t("evidence.resubmitted"),
    );
    if (r) setDialog(null);
  }

  const lastRejection =
    status === "REJECTED" ? history[history.length - 1] : null;

  return (
    <Card>
      <CardHeader
        title={t("evidence.title")}
        description={t("evidence.text")}
        icon={<ShieldCheck className="h-4 w-4" />}
        actions={
          rule?.requireReview || history.length ? (
            <Badge
              className={cn(TONE[status ?? "NONE"])}
              data-testid="evidence-status"
            >
              {t.dyn(`evidence.status.${status ?? "NONE"}`)}
            </Badge>
          ) : undefined
        }
      />
      <div className="space-y-4 p-5">
        {rule && (
          <ul className="space-y-1.5 text-sm" aria-label={t("evidence.title")}>
            {items.map((i) => (
              <li
                key={i.label}
                className={cn(
                  "flex items-center gap-2",
                  i.done ? "text-fg" : "text-fg-muted",
                )}
              >
                {i.done ? (
                  <CheckCircle2
                    className="h-4 w-4 shrink-0 text-success"
                    aria-hidden
                  />
                ) : (
                  <Circle
                    className="h-4 w-4 shrink-0 text-fg-subtle"
                    aria-hidden
                  />
                )}
                <span>{i.label}</span>
                <span className="sr-only">
                  {i.done ? t("common.yes") : t("common.no")}
                </span>
              </li>
            ))}
            {rule.requireReview && (
              <li className="flex items-center gap-2 text-fg-muted">
                <BadgeCheck
                  className="h-4 w-4 shrink-0 text-fg-subtle"
                  aria-hidden
                />{" "}
                {t("evidence.req.review")}
              </li>
            )}
          </ul>
        )}

        {rule &&
          status !== "APPROVED" &&
          (shownMissing.length ? (
            <div className="rounded-lg border border-warning/40 bg-warning-soft p-3 text-sm">
              <p className="mb-1.5 flex items-center gap-2 font-medium text-fg">
                <CircleAlert className="h-4 w-4 shrink-0 text-warning" />{" "}
                {t("evidence.needs")}
              </p>
              <ul className="list-disc space-y-0.5 ps-9 text-fg-muted">
                {shownMissing.map((m) => (
                  <li key={m.key}>
                    {t(m.key, m.count ? { count: m.count } : undefined)}
                  </li>
                ))}
              </ul>
            </div>
          ) : (
            <p className="flex items-center gap-2 text-sm text-success">
              <CheckCircle2 className="h-4 w-4" /> {t("evidence.complete")}
            </p>
          ))}

        {lastRejection?.note && (
          <Alert tone="danger" title={t("evidence.status.REJECTED")}>
            <span className="whitespace-pre-line" dir="auto">
              {lastRejection.note}
            </span>
          </Alert>
        )}

        {(can.review || can.resubmit) && (
          <div className="flex flex-wrap gap-2">
            {can.review && (
              <>
                <Button onClick={() => open("APPROVED")}>
                  <BadgeCheck className="h-4 w-4" /> {t("evidence.approve")}
                </Button>
                <Button variant="outline" onClick={() => open("REJECTED")}>
                  <Undo2 className="h-4 w-4 rtl:-scale-x-100" />{" "}
                  {t("evidence.reject")}
                </Button>
              </>
            )}
            {can.resubmit && (
              <Button onClick={() => open("RESUBMIT")}>
                <RotateCcw className="h-4 w-4" /> {t("evidence.resubmit")}
              </Button>
            )}
          </div>
        )}

        {history.length > 0 && (
          <div>
            <h3 className="mb-2 text-sm font-semibold text-fg">
              {t("evidence.history")}
            </h3>
            <ol className="space-y-2 border-s border-line ps-4 text-sm">
              {history.map((h) => (
                <li key={h.id}>
                  <p className="text-fg">
                    {t.dyn(`evidence.events.${h.event}`, {
                      name: h.actor.name,
                    })}
                  </p>
                  <p className="text-xs text-fg-subtle">
                    {dateTime(h.at, tz, t.locale)}
                  </p>
                  {h.event === "SUBMITTED" && h.customerConfirmed && (
                    <p className="text-xs text-fg-muted">
                      {h.customerName
                        ? t("evidence.confirmedBy", { name: h.customerName })
                        : t("evidence.confirmedNoName")}
                    </p>
                  )}
                  {h.note && (
                    <p
                      className="mt-0.5 whitespace-pre-line text-fg-muted"
                      dir="auto"
                    >
                      {h.note}
                    </p>
                  )}
                </li>
              ))}
            </ol>
          </div>
        )}
      </div>

      <Dialog
        open={dialog === "APPROVED" || dialog === "REJECTED"}
        onClose={() => setDialog(null)}
        title={t(
          dialog === "REJECTED"
            ? "evidence.rejectTitle"
            : "evidence.approveTitle",
        )}
        description={t(
          dialog === "REJECTED"
            ? "evidence.rejectText"
            : "evidence.approveText",
        )}
        size="sm"
        footer={
          <>
            <Button
              variant="ghost"
              onClick={() => setDialog(null)}
              disabled={busy}
            >
              {t("common.cancel")}
            </Button>
            <Button
              variant={dialog === "REJECTED" ? "danger" : "primary"}
              loading={busy}
              onClick={() =>
                void decide(dialog === "REJECTED" ? "REJECTED" : "APPROVED")
              }
            >
              {t(
                dialog === "REJECTED" ? "evidence.reject" : "evidence.approve",
              )}
            </Button>
          </>
        }
      >
        <Field
          label={t(dialog === "REJECTED" ? "evidence.reason" : "evidence.note")}
          required={dialog === "REJECTED"}
          error={errors.note}
        >
          {(p) => (
            <Textarea
              {...p}
              value={note}
              onChange={(e) => setNote(e.target.value)}
              rows={3}
              maxLength={1000}
              dir="auto"
            />
          )}
        </Field>
      </Dialog>

      <Dialog
        open={dialog === "RESUBMIT"}
        onClose={() => setDialog(null)}
        title={t("evidence.resubmitTitle")}
        description={t("evidence.resubmitText")}
        size="sm"
        footer={
          <>
            <Button
              variant="ghost"
              onClick={() => setDialog(null)}
              disabled={busy}
            >
              {t("common.cancel")}
            </Button>
            <Button loading={busy} onClick={() => void resubmit()}>
              {t("evidence.resubmit")}
            </Button>
          </>
        }
      >
        <div className="space-y-4">
          {errors._form && (
            <Alert tone="danger">
              <span className="whitespace-pre-line">{t.msg(errors._form)}</span>
            </Alert>
          )}
          {rule?.requireCustomerConfirmation && (
            <>
              <Checkbox
                label={t("evidence.customerConfirmed")}
                checked={confirmed}
                onChange={(e) => setConfirmed(e.target.checked)}
              />
              <Field
                label={t("evidence.customerName")}
                error={errors.customerName}
              >
                {(p) => (
                  <Input
                    {...p}
                    value={customerName}
                    onChange={(e) => setCustomerName(e.target.value)}
                    maxLength={120}
                    dir="auto"
                  />
                )}
              </Field>
            </>
          )}
          <Field label={t("evidence.note")} error={errors.note}>
            {(p) => (
              <Textarea
                {...p}
                value={note}
                onChange={(e) => setNote(e.target.value)}
                rows={2}
                maxLength={1000}
                dir="auto"
              />
            )}
          </Field>
        </div>
      </Dialog>
    </Card>
  );
}
