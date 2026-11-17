"use client";

import { useState } from "react";
import Link from "next/link";
import { CalendarClock } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardHeader } from "@/components/ui/card";
import { Dialog } from "@/components/ui/dialog";
import { Field, Input, Textarea } from "@/components/ui/field";
import { Badge } from "@/components/ui/misc";
import { ConfirmButton } from "@/components/erp/confirm-dialog";
import { useAction } from "@/components/erp/use-action";
import { useT } from "@/i18n/client";
import { api } from "@/lib/api-client";
import { dateKey, timeKey } from "@/lib/time";
import type { RescheduleRequestDTO } from "@/server/services/reschedule-requests";

const when = (iso: string, tz: string) => `${dateKey(iso, tz)} ${timeKey(iso, tz)}`;

/** Done (after moving the booking) or declined with a note: for whoever may edit the booking. */
function Resolve({ r }: { r: RescheduleRequestDTO }) {
  const t = useT();
  const { busy, errors, run } = useAction();
  const answer = (status: "DONE" | "DECLINED", note: string) =>
    run(() => api(`/api/reschedule-requests/${r.id}`, { method: "POST", body: { status, note } }), () => t(status === "DONE" ? "reschedule.doneMsg" : "reschedule.declinedMsg")).then((x) => x !== null);
  return (
    <div className="flex flex-wrap gap-2">
      <ConfirmButton
        size="sm"
        label={t("reschedule.markDone")}
        title={t("reschedule.markDoneTitle", { code: r.code })}
        text={t("reschedule.markDoneText")}
        confirmLabel={t("reschedule.markDone")}
        reason={{ label: t("common.noteOptional") }}
        busy={busy}
        error={errors._form}
        onConfirm={(note) => answer("DONE", note)}
      />
      <ConfirmButton
        size="sm"
        variant="outline"
        label={t("reschedule.decline")}
        title={t("reschedule.declineTitle", { code: r.code })}
        text={t("reschedule.declineText")}
        confirmLabel={t("reschedule.decline")}
        reason={{ label: t("reschedule.declineNote"), required: true }}
        busy={busy}
        error={errors.note ?? errors._form}
        onConfirm={(note) => answer("DECLINED", note)}
      />
    </div>
  );
}

function RequestBody({ r, tz }: { r: RescheduleRequestDTO; tz: string }) {
  const t = useT();
  return (
    <>
      <p className="text-sm text-fg" dir="auto">
        {r.reason}
      </p>
      <p className="mt-1 text-xs text-fg-muted">
        {t("reschedule.by", { name: r.requestedBy, when: when(r.createdAt, tz) })}
        {r.proposedStart ? ` · ${t("reschedule.proposed", { when: when(r.proposedStart, tz) })}` : ""}
      </p>
      {r.status !== "OPEN" && (
        <p className="mt-1 text-xs text-fg-muted">
          {t(r.status === "DONE" ? "reschedule.doneBy" : "reschedule.declinedBy", { name: r.resolvedBy ?? "", when: r.resolvedAt ? when(r.resolvedAt, tz) : "" })}
          {r.resolutionNote ? ` · ${r.resolutionNote}` : ""}
        </p>
      )}
    </>
  );
}

/** Open requests on the company schedule (people who edit bookings). */
export function RescheduleQueue({ requests, tz }: { requests: RescheduleRequestDTO[]; tz: string }) {
  const t = useT();
  return (
    <Card className="mb-4">
      <CardHeader title={t("reschedule.queueTitle", { count: requests.length })} description={t("reschedule.queueText")} icon={<CalendarClock className="h-4 w-4" />} />
      <ul className="divide-y divide-line">
        {requests.map((r) => (
          <li key={r.id} className="flex flex-col gap-2 px-5 py-3 sm:flex-row sm:items-start sm:justify-between" data-reschedule={r.code}>
            <div className="min-w-0">
              <Link href={`/appointments/${r.appointmentId}`} className="font-medium text-brand-text hover:underline">
                <bdi>{r.code}</bdi>
              </Link>
              <RequestBody r={r} tz={tz} />
            </div>
            <Resolve r={r} />
          </li>
        ))}
      </ul>
    </Card>
  );
}

/** On a visit: the assigned technician asks to move it; whoever edits the booking answers. */
export function RescheduleRequestPanel({
  appointmentId,
  requests,
  canRequest,
  canResolve,
  tz,
}: {
  appointmentId: string;
  requests: RescheduleRequestDTO[];
  canRequest: boolean;
  canResolve: boolean;
  tz: string;
}) {
  const t = useT();
  const { busy, errors, run } = useAction();
  const [open, setOpen] = useState(false);
  const [v, setV] = useState({ reason: "", proposedDate: "", proposedTime: "" });
  const hasOpen = requests.some((r) => r.status === "OPEN");
  if (!requests.length && !canRequest) return null;
  return (
    <Card className="mt-6">
      <CardHeader
        title={t("reschedule.title")}
        icon={<CalendarClock className="h-4 w-4" />}
        actions={
          canRequest &&
          !hasOpen && (
            <Button size="sm" variant="outline" onClick={() => setOpen(true)}>
              {t("reschedule.request")}
            </Button>
          )
        }
      />
      {requests.length === 0 ? (
        <p className="px-5 pb-5 text-sm text-fg-muted">{t("reschedule.none")}</p>
      ) : (
        <ul className="divide-y divide-line">
          {requests.map((r) => (
            <li key={r.id} className="flex flex-col gap-2 px-5 py-3 sm:flex-row sm:items-start sm:justify-between">
              <div className="min-w-0">
                <Badge>{t.dyn(`reschedule.statuses.${r.status}`)}</Badge>
                <div className="mt-1">
                  <RequestBody r={r} tz={tz} />
                </div>
              </div>
              {canResolve && r.status === "OPEN" && <Resolve r={r} />}
            </li>
          ))}
        </ul>
      )}
      <Dialog open={open} onClose={() => setOpen(false)} title={t("reschedule.request")}>
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <Field label={t("reschedule.reason")} required error={t.msg(errors.reason)} className="sm:col-span-2">
            {(p) => <Textarea {...p} rows={3} value={v.reason} onChange={(e) => setV({ ...v, reason: e.target.value })} maxLength={1000} dir="auto" />}
          </Field>
          <Field label={t("reschedule.proposedDate")} error={t.msg(errors.proposedDate)}>
            {(p) => <Input {...p} type="date" value={v.proposedDate} onChange={(e) => setV({ ...v, proposedDate: e.target.value })} />}
          </Field>
          <Field label={t("reschedule.proposedTime")} error={t.msg(errors.proposedTime)}>
            {(p) => <Input {...p} type="time" value={v.proposedTime} onChange={(e) => setV({ ...v, proposedTime: e.target.value })} />}
          </Field>
        </div>
        {errors._form && (
          <p className="mt-3 text-sm font-medium text-danger" role="alert">
            {t.msg(errors._form)}
          </p>
        )}
        <div className="mt-4 flex justify-end">
          <Button
            loading={busy}
            onClick={async () => {
              const r = await run(() => api(`/api/appointments/${appointmentId}/reschedule-requests`, { method: "POST", body: v }), () => t("reschedule.sent"));
              if (r !== null) {
                setOpen(false);
                setV({ reason: "", proposedDate: "", proposedTime: "" });
              }
            }}
          >
            {t("reschedule.send")}
          </Button>
        </div>
      </Dialog>
    </Card>
  );
}
