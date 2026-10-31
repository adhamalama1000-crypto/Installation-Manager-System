"use client";

import { MessageSquareHeart } from "lucide-react";
import { Card, CardHeader } from "@/components/ui/card";
import { useT } from "@/i18n/client";
import { dateTime } from "@/lib/format";
import type { FeedbackDTO } from "@/lib/types";
import { CallForm, GradeForm, RatingForm } from "./feedback-forms";
import { Stars } from "./stars";

/** The customer's rating, the quality grade and the maintenance calls of a visit. */
export function FeedbackCard({ appointmentId, feedback: f, tz }: { appointmentId: string; feedback: FeedbackDTO; tz: string }) {
  const t = useT();
  const L = t.locale;
  const pendingCalls = ([6, 12] as const).filter((m) => !f.calls.some((c) => c.milestone === m));
  if (f.rating === null && f.grade === null && !f.calls.length && !f.rights.rate && !f.rights.grade && !f.rights.call) return null;
  return (
    <Card>
      <CardHeader title={t("afterSales.feedback")} description={t("afterSales.feedbackText")} icon={<MessageSquareHeart className="h-4 w-4" />} />
      <div className="divide-y divide-line">
        <section className="space-y-2 p-5" aria-label={t("afterSales.rating")}>
          <h3 className="text-sm font-semibold text-fg">{t("afterSales.rating")}</h3>
          {f.rights.rate ? (
            <RatingForm appointmentId={appointmentId} rating={f.rating} note={f.ratingNote} />
          ) : f.rating !== null ? (
            <div className="space-y-1">
              <Stars value={f.rating} label={t("afterSales.rating")} />
              {f.ratingNote && (
                <p dir="auto" className="text-start text-sm text-fg">
                  {f.ratingNote}
                </p>
              )}
            </div>
          ) : (
            <p className="text-sm text-fg-subtle">{t("afterSales.notRated")}</p>
          )}
          {f.ratedBy && f.ratedAt && <p className="text-xs text-fg-subtle">{t("afterSales.ratedBy", { name: f.ratedBy.name, when: dateTime(f.ratedAt, tz, L) })}</p>}
        </section>

        {(f.grade !== null || f.rights.grade) && (
          <section className="space-y-2 p-5" aria-label={t("afterSales.grade")}>
            <h3 className="text-sm font-semibold text-fg">{t("afterSales.grade")}</h3>
            {f.rights.grade ? <GradeForm appointmentId={appointmentId} grade={f.grade} /> : <Stars value={f.grade} label={t("afterSales.grade")} />}
            {f.gradedBy && f.gradedAt && <p className="text-xs text-fg-subtle">{t("afterSales.ratedBy", { name: f.gradedBy.name, when: dateTime(f.gradedAt, tz, L) })}</p>}
          </section>
        )}

        {(f.calls.length > 0 || f.rights.call) && (
          <section className="space-y-2 p-5" aria-label={t("afterSales.calls")}>
            <h3 className="text-sm font-semibold text-fg">{t("afterSales.calls")}</h3>
            {f.calls.length ? (
              <ul className="space-y-1 text-sm">
                {f.calls.map((c) => (
                  <li key={c.milestone}>
                    <span className="text-fg">{t("afterSales.callBy", { months: c.milestone, name: c.calledBy.name, when: dateTime(c.createdAt, tz, L) })}</span>
                    {c.note && (
                      <span dir="auto" className="block text-start text-fg-muted">
                        {c.note}
                      </span>
                    )}
                  </li>
                ))}
              </ul>
            ) : (
              <p className="text-sm text-fg-subtle">{t("afterSales.noCalls")}</p>
            )}
            {f.rights.call && pendingCalls.map((m) => <CallForm key={m} appointmentId={appointmentId} months={m} />)}
          </section>
        )}
      </div>
    </Card>
  );
}
